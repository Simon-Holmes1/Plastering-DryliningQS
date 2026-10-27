import { useEffect, useMemo, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

// Bound bitmap memory without changing the PDF coordinate system or measurement scale.
function pdfCanvasScale(width: number,height: number,density = window.devicePixelRatio || 1) {
  const touch=window.matchMedia?.('(pointer: coarse)').matches || (typeof navigator!=='undefined' && navigator.maxTouchPoints>0)
  const maxPixels=touch ? 4000000 : 16000000,maxSide=touch ? 4096 : 8192
  return Math.min(Math.max(1,density),Math.sqrt(maxPixels/Math.max(1,width*height)),maxSide/Math.max(1,width,height))
}

type PdfDoc = Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>
type ViewMode = 'fit-page' | 'manual'

type Point = {
  x: number
  y: number
}

type Calibration = {
  pointA: Point
  pointB: Point
  distanceMm: number
  mmPerPdfUnit: number
  locked: boolean
  needsRecalibration: boolean
}

type BoardType = 'STD' | 'MR' | 'FIRE' | 'SOUND' | 'THERMAL' | 'INS' | 'CELO'
type BoardSpec = { boardType: BoardType; thicknessMm: number; widthMm: number; lengthMm: number; heightOverrideMm?: number }
type BoardChoice = BoardSpec | null | undefined
const boardTypes: BoardType[] = ['STD','MR','FIRE','SOUND','THERMAL','INS','CELO']
const boardThicknesses = [12.5,15,19]
const thermalThicknesses = [22,27,30,35,40,50,60,70,90]
const boardSizes: Array<[number,number]> = [[1200,2300],[1200,2400],[1200,2500],[1200,2700],[900,1800],[900,2400],[600,2400]]
function boardSpecLabel(spec: BoardChoice) {return spec===null ? 'Not applicable' : spec ? spec.boardType+' · '+spec.thicknessMm+'mm'+(spec.boardType==='INS' ? ' · Roll' : ' · '+spec.widthMm+' × '+spec.lengthMm+'mm') : 'Choose board specification'}
function boardThicknessOptions(type: BoardType) {return type==='INS' ? [50,65,100,200] : type==='CELO' ? [25,50,90,100,120,150] : type==='THERMAL' ? thermalThicknesses : type==='STD' ? boardThicknesses : [12.5,15]}
const defaultBoardSizeOrder=boardSizes.map(([w,l])=>w+'x'+l)
type QuantityPriceRow={id:string;name:string;mode:string;totalAreaM2:number|null;totalMm:number|null;count:number;wallsWithoutHeight?:number}
type RateBook = Record<string,number>
function roundWorkValue(value:number) {const pence=Math.round((value+Number.EPSILON)*100);return Math.floor(pence/100)+(pence%100>=50 ? 1 : 0)}
function pounds(value:number) {return '£'+value.toLocaleString('en-GB',{maximumFractionDigits:0})}
function validRateText(text:string) {return text.trim()!=='' && Number.isFinite(Number(text)) && Number(text)>=0}
function validMaterialWasteKey(id:string) {
  if(id==='adhesive' || id==='skim')return true
  const parts=id.split('|');return parts.length===4 && validBoardSpec({boardType:parts[0],thicknessMm:Number(parts[1]),widthMm:Number(parts[2]),lengthMm:Number(parts[3])},true)
}
function validBoardSpec(spec: any,allowLegacy=false): boolean {
  if(spec===undefined || spec===null)return true
  return !!spec && typeof spec==='object' && !Array.isArray(spec) && boardTypes.includes(spec.boardType)
    && (boardThicknessOptions(spec.boardType).includes(spec.thicknessMm) || allowLegacy && ['STD','MR','FIRE','SOUND'].includes(spec.boardType) && spec.thicknessMm===19)
    && (spec.boardType==='INS' ? spec.widthMm===0 && spec.lengthMm===0 : ['THERMAL','CELO'].includes(spec.boardType) ? spec.widthMm===1200 && spec.lengthMm===2400 : boardSizes.some(([w,l])=>w===spec.widthMm && l===spec.lengthMm))
    && (spec.heightOverrideMm===undefined || typeof spec.heightOverrideMm==='number' && Number.isFinite(spec.heightOverrideMm) && spec.heightOverrideMm>0)
}
function boardHeightMismatch(spec: BoardChoice,heightM?: number) {
  return !!spec && spec.boardType!=='INS' && !!heightM && heightM*1000>spec.lengthMm+0.001 && Math.abs((spec.heightOverrideMm ?? 0)-heightM*1000)>0.001
}

const doorOpeningHeightMm=2000
function wallAreaFromLength(lengthMm:number,heightM:number,doorHead=false) {return doorHead ? heightM>doorOpeningHeightMm/1000 ? lengthMm/1000*(heightM-doorOpeningHeightMm/1000)*2 : null : lengthMm/1000*heightM}

type LengthMeasurement = {
  doorHead?: true
  id: string
  name?: string
  groupId?: string
  heightM?: number
  boardSpec?: BoardSpec | null
  pointA: Point
  pointB: Point
  locked: boolean
}

type Pan = {
  x: number
  y: number
}

type RunMeasurement = {
  id: string
  name?: string
  groupId?: string
  heightM?: number
  boardSpec?: BoardSpec | null
  // Shared corners keep adjacent segments connected when edited.
  points: Point[]
  locked: boolean
}

type MeasurementGroup = { id: string; name: string; categoryId?: string; includeSkim?: boolean; appearance?: { color?: string; width?: number; opacity?: number } }
type WorkHeading = 'Tack' | 'Dab' | 'Skim' | 'Insulation' | 'Metal'
type WorkCategory = { menuOrder?: number; heading?: WorkHeading; id: string; name: string; color: string; mode: 'measure' | 'count' | 'derived'; skimTarget?: 'walls' | 'ceilings' }
type CountMeasurement = { boardSpec?: BoardSpec | null; id: string; name?: string; groupId?: string; categoryId?: string; point: Point; locked: boolean }
type BoardTarget = {id:string;page:number} | {groupId:string;page:number}
type MaterialTrade='all'|WorkHeading
function isIpadLandscape(userAgent:string,platform:string,touchPoints:number,width:number,height:number) {return (/iPad/i.test(userAgent) || platform==='MacIntel' && touchPoints>1) && width>=768 && width>height}
type MaterialCoverage = {adhesive:number;skim:number;insulation:Record<string,number>}
const defaultInsulationCoverage:Record<string,number>={'50':15.6,'65':12,'100':11,'200':6}
type MeasurementKind = 'length' | 'run' | 'area' | 'point'

type UiIconName = 'file' | 'save' | 'import' | 'length' | 'run' | 'area' | 'point' | 'check' | 'work' | 'summary' | 'lock' | 'unlock' | 'mixed-lock' | 'snap' | 'endpoint' | 'midpoint' | 'snap-pdf' | 'snap-measure' | 'snap-both' | 'eye' | 'eye-off' | 'door-head'
const uiIconPaths: Record<UiIconName, string> = {
  'door-head': 'M5 22V2h14v20 M5 7h14 M5 3h14 M5 5h14 M8 22V10h8v12 M13 16h1',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  'eye-off': 'M2 2l20 20 M4 7c-1 1-2 3-2 5 0 0 4 7 10 7 2 0 4-1 5-2 M8 5c1 0 3-1 4-1 6 0 10 8 10 8l-3 4 M10 10a3 3 0 0 0 4 4',
  file: 'M6 3h8l4 4v14H6z M14 3v5h5 M9 12h6 M9 16h6',
  save: 'M5 3h12l3 3v15H4V3z M8 3v6h8V3 M8 21v-8h8v8',
  import: 'M12 15V3 M7 8l5-5 5 5 M4 14v6h16v-6',
  length: 'M4 20L20 4 M3 17l4 4 M17 3l4 4',
  run: 'M5 16h7V7h7 M3 14h4v4H3z M10 5h4v4h-4z M17 5h4v4h-4z',
  area: 'M4 8V4h4 M12 4h3 M19 4h1v4 M20 12v3 M20 19v1h-4 M12 20H9 M5 20H4v-4 M4 12v-1',
  point: 'M6 6l12 12 M18 6L6 18 M12 2v2 M12 20v2 M2 12h2 M20 12h2',
  check: 'M5 12l4 4L19 6',
  work: 'M4 5h2 M10 5h10 M4 12h2 M10 12h10 M4 19h2 M10 19h10',
  summary: 'M4 20V4 M4 20h17 M9 16v-4 M14 16V8 M19 16V5',
  'snap-pdf': 'M5 2h9l5 5v15H5z M14 2v6h5 M8 12h3v4H8v3 M14 12h2v7h-2 M8 16h3',
  'snap-measure': 'M3 19L21 5 M3 16v5h5 M16 3h5v5 M11 9l4 4',
  'snap-both': 'M3 2h8l4 4v8H3z M10 2v5h5 M7 21L21 7 M6 18v4h4 M18 6h4v4',
  snap: 'M5 4v8a7 7 0 0 0 14 0V4h-4v8a3 3 0 0 1-6 0V4z M5 8h4 M15 8h4',
  endpoint: 'M5 19L19 5 M3 17h4v4H3z M17 3h4v4h-4z',
  midpoint: 'M3 19L21 5 M12 8l4 4-4 4-4-4z',
  lock: 'M7 10V7a5 5 0 0 1 10 0v3 M5 10h14v11H5z M12 14v3',
  unlock: 'M7 10V7a5 5 0 0 1 9-3 M5 10h14v11H5z M12 14v3',
  'mixed-lock': 'M7 10V7a5 5 0 0 1 10 0v3 M5 10h14v11H5z M9 16h6',
}
function UiIcon({ name, className = '' }: { name: UiIconName; className?: string }) {
  return <svg className={`ui-icon ${className}`} viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={uiIconPaths[name]} /></svg>
}

const pointTrades=['Tack','Dab','Skim','Metal'] as const
type PointTrade=typeof pointTrades[number]
type PointMarkerKind='marker'|'treds'|'svp'
const pointMarkerLabels:Record<PointMarkerKind,string>={marker:'Point Marker',treds:'Treds',svp:'SVP Boxing'}
const pointMarkerCategories:WorkCategory[]=pointTrades.flatMap(trade=>(['marker','treds','svp'] as PointMarkerKind[]).map(kind=>({id:'point-'+kind+'-'+trade.toLowerCase(),name:trade+' · '+pointMarkerLabels[kind],heading:trade,mode:'count' as const,color:({Tack:'#0f766e',Dab:'#c2410c',Skim:'#9333ea',Metal:'#475569'})[trade]})))
const initialCategories: WorkCategory[] = [
  { id: 'tack-ceiling', name: 'Tack Ceiling', color: '#2563eb', mode: 'measure', skimTarget: 'ceilings' },
  { id: 'tack-timber-wall', name: 'Tack Timber Studs', color: '#0f766e', mode: 'measure', skimTarget: 'walls' },
  { id: 'tack-metal-wall', name: 'Tack Metal Studs', color: '#7c3aed', mode: 'measure', skimTarget: 'walls' },
  { id: 'dabbed-external-wall', name: 'Dabbed External Wall', color: '#c2410c', mode: 'measure', skimTarget: 'walls' },
  { id: 'dabbed-internal-wall', name: 'Dabbed Internal Wall', color: '#be185d', mode: 'measure', skimTarget: 'walls' },
  { id: 'metal-studwork', name: 'Metal Studwork', color: '#475569', mode: 'measure' },
  { id: 'insulated-ceiling', name: 'Insulated Ceiling', color: '#a16207', mode: 'measure' },
  { id: 'insulated-wall', name: 'Insulated Wall', color: '#15803d', mode: 'measure' },
  { id: 'svp-boxing', name: 'SVP Boxing', color: '#dc2626', mode: 'count' },
  { id: 'skimmed-walls', name: 'Skimmed Walls', color: '#9333ea', mode: 'derived' },
  { id: 'skimmed-ceiling', name: 'Skimmed Ceiling', color: '#0369a1', mode: 'derived' },
  {"id":"tack-treds","name":"Tack Treds","color":"#0d9488","mode":"measure","skimTarget":"ceilings"},
  {"id":"insulation-ceiling-100","name":"Insulation Ceilings / 100mm","color":"#a16207","mode":"measure"},
  {"id":"insulation-ceiling-200","name":"Insulation Ceilings / 200mm","color":"#a16207","mode":"measure"},
  {"id":"insulation-wall-50","name":"Insulation Walls / 50mm","color":"#15803d","mode":"measure"},
  {"id":"insulation-wall-65","name":"Insulation Walls / 65mm","color":"#15803d","mode":"measure"},
  {"id":"insulation-celotex-25","name":"Celotex / 25mm","color":"#65a30d","mode":"measure"},
  {"id":"insulation-celotex-50","name":"Celotex / 50mm","color":"#65a30d","mode":"measure"},
  {"id":"insulation-celotex-90","name":"Celotex / 90mm","color":"#65a30d","mode":"measure"},
  {"id":"insulation-celotex-100","name":"Celotex / 100mm","color":"#65a30d","mode":"measure"},
  {"id":"insulation-celotex-120","name":"Celotex / 120mm","color":"#65a30d","mode":"measure"},
  {"id":"insulation-celotex-150","name":"Celotex / 150mm","color":"#65a30d","mode":"measure"},
  {"id":"metal-mf-ceiling","name":"Metal MF Ceiling","color":"#475569","mode":"measure"},
  {"id":"metal-stud-50-400","name":"Metal 50/400mm Stud Wall","color":"#4f46e5","mode":"measure"},
  {"id":"metal-stud-50-450","name":"Metal 50/450mm Stud Wall","color":"#4f46e5","mode":"measure"},
  {"id":"metal-stud-50-600","name":"Metal 50/600mm Stud Wall","color":"#4f46e5","mode":"measure"},
  {"id":"metal-stud-70-400","name":"Metal 70/400mm Stud Wall","color":"#7c3aed","mode":"measure"},
  {"id":"metal-stud-70-450","name":"Metal 70/450mm Stud Wall","color":"#7c3aed","mode":"measure"},
  {"id":"metal-stud-70-600","name":"Metal 70/600mm Stud Wall","color":"#7c3aed","mode":"measure"},
  {"id":"metal-deflection-head","name":"Metal Deflection Head","color":"#64748b","mode":"measure"},
  ...pointMarkerCategories,
]

const descriptionSections: Array<{title:string;options:Array<[string,string]>}> = [{"title":"Tack","options":[["tack-ceiling","Ceilings"],["tack-timber-wall","Timber Studs"],["tack-metal-wall","Metal Studs"]]},{"title":"Dab","options":[["dabbed-external-wall","External Walls"],["dabbed-internal-wall","Internal Walls"]]},{"title":"Skim","options":[["skimmed-ceiling","Ceilings"],["skimmed-walls","Walls"]]},{"title":"Insulation","options":[["insulation-ceiling-100","Ceilings / 100mm"],["insulation-ceiling-200","Ceilings / 200mm"],["insulation-wall-50","Walls / 50mm"],["insulation-wall-65","Walls / 65mm"],["insulation-celotex-25","Celotex / 25mm"],["insulation-celotex-50","Celotex / 50mm"],["insulation-celotex-90","Celotex / 90mm"],["insulation-celotex-100","Celotex / 100mm"],["insulation-celotex-120","Celotex / 120mm"],["insulation-celotex-150","Celotex / 150mm"]]},{"title":"Metal","options":[["metal-mf-ceiling","MF Ceiling"],["metal-stud-50-400","50/400mm Stud Wall"],["metal-stud-50-450","50/450mm Stud Wall"],["metal-stud-50-600","50/600mm Stud Wall"],["metal-stud-70-400","70/400mm Stud Wall"],["metal-stud-70-450","70/450mm Stud Wall"],["metal-stud-70-600","70/600mm Stud Wall"],["metal-deflection-head","Deflection Head"]]}]
function categoryWorkHeading(category:WorkCategory) {
  return category.heading ?? descriptionSections.find(section=>section.options.some(([id])=>id===category.id))?.title ?? (category.id==='insulated-ceiling' || category.id==='insulated-wall' ? 'Insulation' : category.id==='metal-studwork' ? 'Metal' : category.id==='tack-treds' ? 'Tack' : '')
}
function defaultSubcontractorRates(categories:WorkCategory[]):RateBook {
  const defaults:Record<string,number>={Tack:2.10,Dab:3.40,Skim:3.45,Insulation:1.30}
  return Object.fromEntries(categories.filter(category=>category.mode!=='count' && defaults[categoryWorkHeading(category)]!==undefined).map(category=>[category.id,defaults[categoryWorkHeading(category)]]))
}
const legacyCategoryIds = new Set(["tack-ceiling","tack-timber-wall","tack-metal-wall","dabbed-external-wall","dabbed-internal-wall","metal-studwork","insulated-ceiling","insulated-wall","svp-boxing","skimmed-walls","skimmed-ceiling"])
function workDescriptionLabel(id: string,categories: WorkCategory[]) {
  const category=categories.find(item=>item.id===id), original=initialCategories.find(item=>item.id===id)
  if(!category) return 'Choose work description'
  if(category.name!==original?.name) return category.heading ? category.heading+' · '+category.name : category.name || id
  const section=descriptionSections.find(section=>section.options.some(([key])=>key===id))
  return section ? section.title+' · '+section.options.find(([key])=>key===id)![1] : category.name
}

type AreaMeasurement = {
  boardSpec?: BoardSpec | null
  id: string
  name?: string
  groupId?: string
  points: Point[]
  locked: boolean
}

function polygonArea(points: Point[]) {
  if (points.length < 3) return 0
  const origin = points[0]
  return Math.abs(points.reduce((sum, a, i) => {
    const b = points[(i + 1) % points.length]
    return sum + (a.x - origin.x) * (b.y - origin.y) - (b.x - origin.x) * (a.y - origin.y)
  }, 0)) / 2
}

function polygonProblem(points: Point[]): string | null {
  if (points.length < 3) return 'Place at least three corners before finishing an area.'
  const epsilon = 0.000001
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) < epsilon) {
        return 'Each corner must be different. Use Finish Area to close the outline.'
      }
    }
  }
  const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  const onSegment = (a: Point, b: Point, c: Point) => Math.abs(cross(a, b, c)) < epsilon
    && c.x >= Math.min(a.x, b.x) - epsilon && c.x <= Math.max(a.x, b.x) + epsilon
    && c.y >= Math.min(a.y, b.y) - epsilon && c.y <= Math.max(a.y, b.y) + epsilon
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length]
    for (let j = i + 1; j < points.length; j++) {
      if (j === i + 1 || (i === 0 && j === points.length - 1)) continue
      const c = points[j], d = points[(j + 1) % points.length]
      const abC = cross(a, b, c), abD = cross(a, b, d)
      const cdA = cross(c, d, a), cdB = cross(c, d, b)
      if ((Math.sign(abC) !== Math.sign(abD) && Math.sign(cdA) !== Math.sign(cdB))
        || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b)) {
        return 'The outline crosses or touches itself. Undo the last point and trace around the outside.'
      }
    }
  }
  return polygonArea(points) > epsilon ? null : 'The outline must enclose an area; the corners cannot all be in a straight line.'
}

type JobDetails = { site: string; plot: string; houseType: string; revision: string }
type DrawingPage = { source: number; page: number; name: string }
type DrawingSource = { name: string; bytes: Uint8Array; doc: PdfDoc }

function defaultDrawingPages(source: DrawingSource, sourceIndex = 0): DrawingPage[] {
  return Array.from({ length: source.doc.numPages }, (_, i) => ({ source: sourceIndex, page: i + 1,
    name: (sourceIndex === 0 ? `Page ${i + 1}` : source.name.replace(/\.pdf$/i, '') + (source.doc.numPages > 1 ? ` — ${i + 1}` : '')).slice(0, 80) }))
}

// The viewer presents retained pages from embedded PDFs as a single drawing set.
// Existing PDF coordinates remain unchanged, preserving calibration and geometry.
function drawingSet(sources: DrawingSource[], pages: DrawingPage[]): PdfDoc {
  return {
    numPages: pages.length,
    getPage(number: number) {
      const page = pages[number - 1]
      if (!page || !sources[page.source]) return Promise.reject(new Error('Drawing page is missing.'))
      return sources[page.source].doc.getPage(page.page)
    },
    async destroy() { await Promise.all(sources.map((source) => source.doc.destroy())) },
  } as unknown as PdfDoc
}

function removePageRecord<T>(record: Record<number, T>, removedPage: number): Record<number, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => Number(key) !== removedPage)
    .map(([key, value]) => [Number(key) > removedPage ? Number(key) - 1 : Number(key), value]))
}


type TakeoffFile = {
  format: 'drylining-takeoff'
  version: 8
  savedAt: string
  drawing: { name: string; pdfBase64: string; additionalPdfs?: Array<{ name: string; pdfBase64: string }>; pages?: DrawingPage[] }
  job: JobDetails
  calibrations: Record<number, Calibration>
  lengths: Record<number, LengthMeasurement[]>
  runs: Record<number, RunMeasurement[]>
  areas: Record<number, AreaMeasurement[]>
  counts: Record<number, CountMeasurement[]>
  categories: WorkCategory[]
  clearedSubcontractorRates: string[]
  subcontractorRates: RateBook
  contractorRates: RateBook
  boardSizeOrder: string[]
  materialWastePercent: number
  materialWasteOverrides: Record<string,number>
  materialCoverage: MaterialCoverage
  nextCountNumber: number
  nextLengthNumber: number
  nextRunNumber: number
  groups: MeasurementGroup[]
  nextGroupNumber: number
  nextAreaNumber: number
  view: { page: number; rotation: number; mode: ViewMode; scale: number; pan: Pan; hiddenGroupIds?: string[]; showUngrouped?: boolean; categoryId?: string; groupId?: string }
}

const emptyJob: JobDetails = { site: '', plot: '', houseType: '', revision: '' }

function encodePdf(bytes: Uint8Array) {
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)))
  }
  return btoa(chunks.join(''))
}

function decodePdf(base64: string) {
  const binary = atob(base64)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function isValidPdfBase64(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return false
  // Avoid repeating regex groups: their backtracking stack overflows on large PDFs.
  if (/[^A-Za-z0-9+/=]/.test(value)) return false
  const paddingStart = value.indexOf('=')
  if (paddingStart === -1) return true
  const paddingLength = value.length - paddingStart
  return (paddingLength === 1 || paddingLength === 2)
    && value[value.length - 1] === '=' && (paddingLength === 1 || value[value.length - 2] === '=')
}

// Validate the whole saved file before replacing the current take-off.
function readTakeoff(value: unknown): TakeoffFile {
  const invalid = () => { throw new Error('This file is incomplete or damaged. Your current take-off has been kept.') }
  const object = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
  const finite = (v: any) => typeof v === 'number' && Number.isFinite(v)
  const integer = (v: any) => Number.isSafeInteger(v) && v >= 1
  const point = (v: any) => object(v) && finite(v.x) && finite(v.y)
  if (!object(value) || value.format !== 'drylining-takeoff') {
    throw new Error('Choose a saved take-off (.takeoff.json), or use Import New Drawing for a PDF.')
  }
  if (![1, 2, 3, 4, 5, 6, 7, 8].includes(value.version)) {
    throw new Error('This take-off uses a different file version. Open it with the version of the app that saved it.')
  }
  if (!object(value.drawing) || typeof value.drawing.name !== 'string' || !value.drawing.name.trim()
    || !isValidPdfBase64(value.drawing.pdfBase64)
    || typeof value.savedAt !== 'string' || !Number.isFinite(Date.parse(value.savedAt))) invalid()
  if (value.version >= 6) {
    if (!Array.isArray(value.drawing.additionalPdfs) || !Array.isArray(value.drawing.pages) || !value.drawing.pages.length) invalid()
    for (const source of value.drawing.additionalPdfs) if (!object(source) || typeof source.name !== 'string' || !source.name.trim() || !isValidPdfBase64(source.pdfBase64)) invalid()
    const seenPages = new Set<string>()
    for (const page of value.drawing.pages) {
      if (!object(page) || !Number.isSafeInteger(page.source) || page.source < 0 || page.source > value.drawing.additionalPdfs.length || !integer(page.page)
        || typeof page.name !== 'string' || !page.name.trim() || page.name.length > 80 || seenPages.has(page.source + ':' + page.page)) invalid()
      seenPages.add(page.source + ':' + page.page)
    }
  }
  if (!object(value.job) || !['site', 'plot', 'houseType', 'revision'].every((key) => typeof value.job[key] === 'string')) invalid()
  const view = value.view
  if (!object(view) || !integer(view.page) || ![0, 90, 180, 270].includes(view.rotation)
    || !['fit-page', 'manual'].includes(view.mode) || !finite(view.scale) || view.scale <= 0 || view.scale > 100
    || !point(view.pan)) invalid()
  if (!integer(value.nextLengthNumber) || !integer(value.nextRunNumber)) invalid()
  const ids = new Set<string>()
  const categories: WorkCategory[] = value.version >= 4 ? value.categories : initialCategories.map((category) => ({ ...category }))
  if (!Array.isArray(categories)) invalid()
  const categoryIds = new Set<string>()
  for (const category of categories) {
    if (!object(category) || typeof category.id !== 'string' || !category.id.length || categoryIds.has(category.id)
      || typeof category.name !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(category.color)
      || !['measure', 'count', 'derived'].includes(category.mode)
      || (category.menuOrder!==undefined && (!Number.isInteger(category.menuOrder) || category.menuOrder<0))
      || (category.heading!==undefined && !['Tack','Dab','Skim','Insulation','Metal'].includes(category.heading))
      || (category.skimTarget !== undefined && (category.mode !== 'measure' || !['walls', 'ceilings'].includes(category.skimTarget)))) invalid()
    categoryIds.add(category.id)
  }
  // Built-in category IDs keep counting and automatic skim rules stable across saves.
  for (const required of initialCategories) {
    const category = categories.find((item) => item.id === required.id)
    if ((!category && legacyCategoryIds.has(required.id)) || (category && (category.mode !== required.mode || category.skimTarget !== required.skimTarget))) invalid()
  }
  const groups: MeasurementGroup[] = value.version === 1 ? [] : value.groups
  const nextGroupNumber = value.version === 1 ? 1 : value.nextGroupNumber
  if (!Array.isArray(groups) || !integer(nextGroupNumber)) invalid()
  const groupIds = new Set<string>()
  for (const group of groups) {
    if (!object(group) || typeof group.id !== 'string' || !/^G\d{3,}$/.test(group.id)
      || !integer(Number(group.id.slice(1))) || Number(group.id.slice(1)) >= nextGroupNumber
      || typeof group.name !== 'string' || groupIds.has(group.id)) invalid()
    if (group.appearance !== undefined && (!object(group.appearance)
      || (group.appearance.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(group.appearance.color))
      || (group.appearance.width !== undefined && (!finite(group.appearance.width) || group.appearance.width < 1 || group.appearance.width > 12))
      || (group.appearance.opacity !== undefined && (!finite(group.appearance.opacity) || group.appearance.opacity < 0.15 || group.appearance.opacity > 1)))) invalid()
    groupIds.add(group.id)
    if (group.includeSkim !== undefined && typeof group.includeSkim !== 'boolean') invalid()
    if (group.categoryId !== undefined && (!categoryIds.has(group.categoryId)
      || categories.find((category) => category.id === group.categoryId)?.mode === 'derived')) invalid()
  }
  function rates(raw:any): RateBook {
    if(raw===undefined)return {}
    if(!object(raw) || Object.entries(raw).some(([id,rate])=>!categoryIds.has(id) || !finite(rate) || (rate as number)<0))invalid()
    return {...raw}
  }
  const clearedSubcontractorRates=value.clearedSubcontractorRates ?? []
  if(!Array.isArray(clearedSubcontractorRates) || new Set(clearedSubcontractorRates).size!==clearedSubcontractorRates.length || clearedSubcontractorRates.some((id:unknown)=>typeof id!=='string' || !categoryIds.has(id)))invalid()
  const defaults=defaultSubcontractorRates([...categories,...initialCategories.filter(category=>!categoryIds.has(category.id))])
  const savedRates=rates(value.subcontractorRates)
  const subcontractorRates={...defaults,...savedRates},contractorRates=rates(value.contractorRates)
  clearedSubcontractorRates.forEach((id:string)=>{if(savedRates[id]!==undefined)invalid();delete subcontractorRates[id]})
  const materialWastePercent=value.materialWastePercent ?? 10
  if(!finite(materialWastePercent) || materialWastePercent<0)invalid()
  const rawCoverage=value.materialCoverage===undefined ? {adhesive:8.5,skim:15} : value.materialCoverage
  if(!object(rawCoverage) || !finite(rawCoverage.adhesive) || rawCoverage.adhesive<=0 || !finite(rawCoverage.skim) || rawCoverage.skim<=0)invalid()
  const insulation=rawCoverage.insulation===undefined ? {...defaultInsulationCoverage} : rawCoverage.insulation
  if(!object(insulation) || Object.keys(insulation).length!==4 || Object.keys(defaultInsulationCoverage).some(key=>!finite(insulation[key]) || insulation[key]<=0))invalid()
  const materialCoverage={adhesive:rawCoverage.adhesive,skim:rawCoverage.skim,insulation:{...insulation}}
  const materialWasteOverrides=value.materialWasteOverrides ?? {}
  if(!object(materialWasteOverrides) || Object.entries(materialWasteOverrides).some(([id,waste])=>!validMaterialWasteKey(id) || !finite(waste) || (waste as number)<0))invalid()
  const order=value.boardSizeOrder
  if(order!==undefined && (!Array.isArray(order) || new Set(order).size!==order.length || order.some((id:unknown)=>typeof id!=='string' || !defaultBoardSizeOrder.includes(id))))invalid()
  const boardSizeOrder=order===undefined ? [...defaultBoardSizeOrder] : [...defaultBoardSizeOrder.filter(id=>!order.includes(id)),...order]
  const fileVersion=value.version
  let maxLength = 0
  let maxRun = 0
  let maxArea = 0
  let maxCount = 0
  function pages(record: any, validate: (item: any) => boolean) {
    if (!object(record)) invalid()
    for (const [key, item] of Object.entries(record)) {
      if (!/^[1-9]\d*$/.test(key) || !integer(Number(key)) || !validate(item)) invalid()
    }
  }
  pages(value.calibrations, (c) => object(c) && point(c.pointA) && point(c.pointB)
    && finite(c.distanceMm) && c.distanceMm > 0 && finite(c.mmPerPdfUnit) && c.mmPerPdfUnit > 0
    && typeof c.locked === 'boolean' && typeof c.needsRecalibration === 'boolean'
    && (c.needsRecalibration || Math.hypot(c.pointA.x - c.pointB.x, c.pointA.y - c.pointB.y) > 0))
  function measurement(item: any, prefix: 'L' | 'R' | 'A' | 'C') {
    if (!object(item) || typeof item.id !== 'string' || !new RegExp(`^${prefix}\\d{3,}$`).test(item.id)
      || typeof item.locked !== 'boolean' || ids.has(item.id)) return false
    if (item.name !== undefined && typeof item.name !== 'string') return false
    if (!validBoardSpec(item.boardSpec,true)) return false
    if (item.doorHead!==undefined && (fileVersion<7 || prefix!=='L' || item.doorHead!==true))return false
    if (item.groupId !== undefined && (typeof item.groupId !== 'string' || !groupIds.has(item.groupId))) return false
    if (item.heightM !== undefined && ((prefix !== 'L' && prefix !== 'R') || !finite(item.heightM) || item.heightM <= 0)) return false
    if (item.groupId) {
      const categoryId = groups.find((group) => group.id === item.groupId)?.categoryId
      const mode = categories.find((category) => category.id === categoryId)?.mode
      if (prefix === 'C' ? mode !== 'count' : mode === 'count') return false
      if (prefix === 'C' && item.categoryId !== undefined && item.categoryId !== categoryId) return false
    }
    if (prefix === 'C' && item.categoryId !== undefined && !categories.some((category) => category.id === item.categoryId && category.mode === 'count')) return false
    const number = Number(item.id.slice(1))
    if (!integer(number)) return false
    ids.add(item.id)
    if (prefix === 'L') maxLength = Math.max(maxLength, number)
    else if (prefix === 'R') maxRun = Math.max(maxRun, number)
    else if (prefix === 'A') maxArea = Math.max(maxArea, number)
    else maxCount = Math.max(maxCount, number)
    return true
  }
  pages(value.lengths, (items) => Array.isArray(items) && items.every((item) =>
    measurement(item, 'L') && point(item.pointA) && point(item.pointB)))
  pages(value.runs, (items) => Array.isArray(items) && items.every((item) =>
    measurement(item, 'R') && Array.isArray(item.points) && item.points.length >= 2
    && item.points.every(point)))
  if (value.nextLengthNumber <= maxLength || value.nextRunNumber <= maxRun) invalid()
  const areas = value.version >= 3 ? value.areas : {}
  const nextAreaNumber = value.version >= 3 ? value.nextAreaNumber : 1
  if (!integer(nextAreaNumber)) invalid()
  pages(areas, (items) => Array.isArray(items) && items.every((item) => measurement(item, 'A')
    && Array.isArray(item.points) && item.points.every(point) && !polygonProblem(item.points)))
  if (nextAreaNumber <= maxArea) invalid()
  const counts = value.version >= 4 ? value.counts : {}
  const nextCountNumber = value.version >= 4 ? value.nextCountNumber : 1
  if (!integer(nextCountNumber)) invalid()
  pages(counts, (items) => Array.isArray(items) && items.every((item) => measurement(item, 'C') && point(item.point)))
  if (nextCountNumber <= maxCount) invalid()
  if (view.hiddenGroupIds !== undefined && (!Array.isArray(view.hiddenGroupIds) || !view.hiddenGroupIds.every((id: unknown) => typeof id === 'string' && groupIds.has(id)))) invalid()
  if (view.showUngrouped !== undefined && typeof view.showUngrouped !== 'boolean') invalid()
  if (view.categoryId !== undefined && (typeof view.categoryId !== 'string' || (view.categoryId !== '' && !categoryIds.has(view.categoryId)))) invalid()
  if (view.groupId !== undefined && (typeof view.groupId !== 'string' || (view.groupId !== '' && !groupIds.has(view.groupId)))) invalid()
  return { ...value, subcontractorRates, clearedSubcontractorRates, contractorRates, boardSizeOrder, materialWastePercent, materialWasteOverrides, materialCoverage, version: 8, drawing: { ...value.drawing, additionalPdfs: value.version >= 6 ? value.drawing.additionalPdfs : [], pages: value.version >= 6 ? value.drawing.pages : undefined }, groups, nextGroupNumber, areas, nextAreaNumber, categories: [...categories.map(category=>({...category,name:category.id==='tack-timber-wall' && category.name==='Tack Timber Wall' ? 'Tack Timber Studs' : category.id==='tack-metal-wall' && category.name==='Tack Metal Wall' ? 'Tack Metal Studs' : category.name})),...initialCategories.filter(category=>!categoryIds.has(category.id)).map(category=>({...category}))], counts, nextCountNumber } as TakeoffFile
}

type SnapSegment = { a: Point; b: Point }
type SnapTarget = Point & { kind: 'endpoint' | 'midpoint'; source: 'PDF' | 'Measure' }
type SnapIndex = Map<string, SnapTarget[]>
const snapCellSize = 32

function makeSnapIndex(segments: SnapSegment[], source: SnapTarget['source']): SnapIndex {
  const index: SnapIndex = new Map()
  const add = (point: Point, kind: SnapTarget['kind']) => {
    const key = `${Math.floor(point.x / snapCellSize)},${Math.floor(point.y / snapCellSize)}`
    const bucket = index.get(key) ?? []
    bucket.push({ ...point, kind, source })
    index.set(key, bucket)
  }
  for (const { a, b } of segments) {
    add(a, 'endpoint'); add(b, 'endpoint')
    add({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, 'midpoint')
  }
  return index
}

// Read numeric PDF paths before PDF.js turns them into browser Path2D objects.
// Coordinates stay in PDF space, so rotation, zoom and pan use the same targets.
function pdfLineSegments(list: { fnArray: ArrayLike<number>; argsArray: any[] }, ops: Record<string, number>): SnapSegment[] {
  type Matrix = [number, number, number, number, number, number]
  let matrix: Matrix = [1, 0, 0, 1, 0, 0]
  const stack: Matrix[] = [], segments: SnapSegment[] = []
  let current: Point | null = null, start: Point | null = null
  const transform = (x: number, y: number): Point => ({ x: matrix[0] * x + matrix[2] * y + matrix[4], y: matrix[1] * x + matrix[3] * y + matrix[5] })
  const multiply = (m: number[]) => {
    const [a,b,c,d,e,f] = matrix, [g,h,i,j,k,l] = m
    matrix = [a*g+c*h, b*g+d*h, a*i+c*j, b*i+d*j, a*k+c*l+e, b*k+d*l+f]
  }
  const move = (x: number, y: number) => { current = transform(x,y); start = current }
  const line = (x: number, y: number) => {
    const b = transform(x,y)
    if (current && Math.hypot(current.x-b.x, current.y-b.y) > 0.01 && segments.length < 100000) segments.push({ a: current, b })
    current = b
  }
  const close = () => {
    if (current && start && Math.hypot(current.x-start.x, current.y-start.y) > 0.01 && segments.length < 100000) segments.push({ a: current, b: start })
    current = start
  }
  for (let n = 0; n < list.fnArray.length && segments.length < 100000; n++) {
    const op = list.fnArray[n], args = list.argsArray[n]
    if (op === ops.save || op === ops.paintFormXObjectBegin) {
      stack.push([...matrix]); if (op === ops.paintFormXObjectBegin && args?.[0]) multiply(args[0])
    } else if (op === ops.restore || op === ops.paintFormXObjectEnd) matrix = stack.pop() ?? [1,0,0,1,0,0]
    else if (op === ops.transform) multiply(args)
    else if (op === ops.constructPath) {
      current = start = null
      // PDF.js 5 uses packed DrawOPS; older versions use separate operators/coordinates.
      if (typeof args[0] === 'number') {
        const data = args[1]?.[0]
        if (!data || typeof data.length !== 'number') continue
        for (let i=0; i<data.length;) {
          const command = data[i++]
          if (command === 0) { move(data[i],data[i+1]); i+=2 }
          else if (command === 1) { line(data[i],data[i+1]); i+=2 }
          else if (command === 2) { current=transform(data[i+4],data[i+5]); i+=6 }
          else if (command === 3) { current=transform(data[i+2],data[i+3]); i+=4 }
          else if (command === 4) close()
          else break
        }
      } else {
        const commands=args[0], coordinates=args[1]; let i=0
        for (const command of commands) {
          if (command === ops.moveTo) { move(coordinates[i],coordinates[i+1]); i+=2 }
          else if (command === ops.lineTo) { line(coordinates[i],coordinates[i+1]); i+=2 }
          else if (command === ops.rectangle) {
            const [x,y,w,h]=coordinates.slice(i,i+4); i+=4
            move(x,y); line(x+w,y); line(x+w,y+h); line(x,y+h); close()
          } else if (command === ops.closePath) close()
          else if (command === ops.curveTo) { current=transform(coordinates[i+4],coordinates[i+5]); i+=6 }
          else if (command === ops.curveTo2 || command === ops.curveTo3) { current=transform(coordinates[i+2],coordinates[i+3]); i+=4 }
        }
      }
      if ([ops.closeStroke, ops.closeFillStroke, ops.closeEOFillStroke].includes(args[0])) close()
    }
  }
  return segments
}

function nearestSnap(point: Point, indices: SnapIndex[], tolerance: number, endpoints: boolean, midpoints: boolean): SnapTarget | null {
  let best: SnapTarget | null = null, distance = tolerance
  for (const index of indices) {
    for (let x=Math.floor((point.x-tolerance)/snapCellSize); x<=Math.floor((point.x+tolerance)/snapCellSize); x++) {
      for (let y=Math.floor((point.y-tolerance)/snapCellSize); y<=Math.floor((point.y+tolerance)/snapCellSize); y++) {
        for (const candidate of index.get(`${x},${y}`) ?? []) {
          if (candidate.kind === 'endpoint' ? !endpoints : !midpoints) continue
          const d=Math.hypot(candidate.x-point.x,candidate.y-point.y)
          if (d<=distance) { distance=d; best=candidate }
        }
      }
    }
  }
  return best
}

function heightInMm(text: string) { return text === '' ? '' : Number.isFinite(Number(text)) ? String(Math.round(Number(text)*1000000)/1000) : text }
function heightFromMm(text: string) { return text === '' ? '' : Number.isFinite(Number(text)) ? String(Number(text)/1000) : text }

type SelectedEditPoint = { id: string; kind: MeasurementKind; index: number; page: number }

function orthogonalPoint(point: Point, anchor: Point): Point {
  return Math.abs(point.x-anchor.x) >= Math.abs(point.y-anchor.y) ? { x:point.x, y:anchor.y } : { x:anchor.x, y:point.y }
}

function polygonLabelPoint(points: Point[]): Point {
  if (!points.length) return {x:0,y:0}
  const inside = (p: Point) => {
    let result=false
    for (let i=0,j=points.length-1;i<points.length;j=i++) {
      const a=points[i],b=points[j]
      if ((a.y>p.y)!==(b.y>p.y) && p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x) result=!result
    }
    return result
  }
  const origin=points[0];let weight=0,cx=0,cy=0
  for(let i=0;i<points.length;i++) { const a=points[i],b=points[(i+1)%points.length],cross=(a.x-origin.x)*(b.y-origin.y)-(b.x-origin.x)*(a.y-origin.y);weight+=cross;cx+=(a.x+b.x-2*origin.x)*cross;cy+=(a.y+b.y-2*origin.y)*cross }
  const centroid=Math.abs(weight)>1e-9 ? {x:origin.x+cx/(3*weight),y:origin.y+cy/(3*weight)} : origin
  if (inside(centroid)) return centroid
  const ys=[...new Set(points.map(p=>p.y))].sort((a,b)=>a-b)
  let best=origin,bestWidth=-1
  for(let n=1;n<ys.length;n++) {
    const y=(ys[n-1]+ys[n])/2,xs:number[]=[]
    for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length];if((a.y>y)!==(b.y>y))xs.push(a.x+(y-a.y)*(b.x-a.x)/(b.y-a.y))}
    xs.sort((a,b)=>a-b)
    for(let i=1;i<xs.length;i+=2)if(xs[i]-xs[i-1]>bestWidth){bestWidth=xs[i]-xs[i-1];best={x:(xs[i]+xs[i-1])/2,y}}
  }
  return best
}


function SummaryDrawingPreview({ pdf, number, rotation, lengths, runs, areas, counts, colorFor, appearanceFor, preparePage }: {
  pdf: PdfDoc; number: number; rotation: number; lengths: LengthMeasurement[]; runs: RunMeasurement[];
  areas: AreaMeasurement[]; counts: Array<CountMeasurement & { previewColor?: string }>; colorFor: (groupId: string | undefined, fallback: string) => string;
  appearanceFor: (groupId?: string) => { width: number; opacity: number };
  preparePage: (number: number, page: any) => Promise<void>;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const [visible, setVisible] = useState(false)
  const [viewport, setViewport] = useState<any>(null)
  const [error, setError] = useState('')
  const [resolution, setResolution] = useState({ width: 0, pixelRatio: 1 })
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined' || !containerRef.current) { setVisible(true); return }
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect() } }, { rootMargin: '500px' })
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!visible || !containerRef.current) return
    const measure = () => {
      const width = Math.ceil(containerRef.current?.getBoundingClientRect().width ?? 0)
      const pixelRatio = Math.max(1, window.devicePixelRatio || 1)
      setResolution((current) => current.width === width && current.pixelRatio === pixelRatio ? current : { width, pixelRatio })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(containerRef.current)
    const densityQuery = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
    densityQuery?.addEventListener('change', measure)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); densityQuery?.removeEventListener('change', measure); window.removeEventListener('resize', measure) }
  }, [visible, resolution.pixelRatio])
  useEffect(() => {
    if (!visible || resolution.width <= 0) return
    let disposed = false, task: any = null
    setViewport(null); setError('')
    async function render() {
      try {
        const page = await pdf.getPage(number)
        if (disposed) return
        await preparePage(number, page)
        if (disposed || !canvas.current) return
        const base = page.getViewport({ scale: 1, rotation })
        const view = page.getViewport({ scale: resolution.width / base.width, rotation })
        const context = canvas.current.getContext('2d')
        if (!context) throw new Error('Drawing preview is unavailable.')
        const outputScale = pdfCanvasScale(view.width,view.height,resolution.pixelRatio)
        canvas.current.width = Math.ceil(view.width * outputScale); canvas.current.height = Math.ceil(view.height * outputScale)
        task = page.render({ canvas: canvas.current, canvasContext: context, viewport: view,
          transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0] })
        await task.promise
        if (!disposed) setViewport(view)
      } catch (failure: any) {
        if (!disposed && failure?.name !== 'RenderingCancelledException') setError('Could not show this drawing preview. Open the drawing to inspect it.')
      }
    }
    void render()
    return () => { disposed = true; task?.cancel() }
  }, [pdf, number, rotation, visible, resolution.width, resolution.pixelRatio])
  const point = (p: Point) => viewport.convertToViewportPoint(p.x, p.y) as [number, number]
  const outline = (points: Point[]) => points.map((p) => point(p).join(',')).join(' ')
  return <div className="summary-drawing-preview" ref={containerRef} style={viewport ? { minHeight: 0, aspectRatio: `${viewport.width} / ${viewport.height}` } : undefined} aria-label={`Drawing ${number} with all measured overlays`}>
    <canvas ref={canvas} aria-label={`Drawing ${number} preview`} />
    {!viewport && !error && <p className="preview-loading">{visible ? 'Loading drawing…' : 'Drawing preview'}</p>}
    {error && <p className="preview-error">{error}</p>}
    {viewport && <svg className="summary-measurement-overlay" viewBox={`0 0 ${viewport.width} ${viewport.height}`} aria-label="All measurements on this drawing">
      {areas.map((item) => <polygon key={item.id} points={outline(item.points)} fill={colorFor(item.groupId, '#c2410c') + '18'} stroke={colorFor(item.groupId, '#c2410c')} strokeWidth={appearanceFor(item.groupId).width} opacity={appearanceFor(item.groupId).opacity} />)}
      {lengths.map((item) => { const a=point(item.pointA), b=point(item.pointB); return <line key={item.id} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={colorFor(item.groupId,'#2563eb')} strokeDasharray={item.doorHead ? '5 3' : undefined} strokeWidth={appearanceFor(item.groupId).width} opacity={appearanceFor(item.groupId).opacity} /> })}
      {runs.map((item) => <polyline key={item.id} points={outline(item.points)} fill="none" stroke={colorFor(item.groupId,'#0f766e')} strokeWidth={appearanceFor(item.groupId).width} opacity={appearanceFor(item.groupId).opacity} />)}
      {counts.map((item) => { const [x,y]=point(item.point); return <path key={item.id} d={`M ${x-7} ${y-7} L ${x+7} ${y+7} M ${x+7} ${y-7} L ${x-7} ${y+7}`} stroke={item.previewColor ?? colorFor(item.groupId,'#dc2626')} strokeWidth={appearanceFor(item.groupId).width} opacity={appearanceFor(item.groupId).opacity} /> })}
    </svg>}
  </div>
}


export default function App() {
  useEffect(() => { document.title = 'Holmes QS' }, [])
  const [jobPanelOpen, setJobPanelOpen] = useState(false)
  const [toolboxOpen, setToolboxOpen] = useState(true)
  const [drawingRenderError,setDrawingRenderError]=useState('')
  const [drawingRendering,setDrawingRendering]=useState(false)
  const [drawingRenderRetry,setDrawingRenderRetry]=useState(0)
  const [toolboxPosition, setToolboxPosition] = useState<Point>({ x: 0, y: 0 })
  const [toolboxDocked,setToolboxDocked]=useState(true)
  const [toolbarOrigin,setToolbarOrigin]=useState<Point>({x:0,y:66})
  const [toolbarBarHeight,setToolbarBarHeight]=useState(66)
  const toolbarHeaderRef=useRef<HTMLElement | null>(null)
  const [descriptionPosition,setDescriptionPosition]=useState<Point>({x:8,y:150})
  const [panelSize,setPanelSize]=useState({width:342,height:160})
  const [panelMenu,setPanelMenu]=useState<Point | null>(null)
  const descriptionMenuRef=useRef<HTMLDivElement | null>(null)
  const descriptionSummaryRef=useRef<HTMLElement | null>(null)
  const [descriptionOpen,setDescriptionOpen]=useState(false)
  const [boardPreferences,setBoardPreferences]=useState<Record<string,BoardSpec | null>>({})
  const [boardPickerOpen,setBoardPickerOpen]=useState(false)
  const [boardSizeOrder,setBoardSizeOrder]=useState<string[]>([...defaultBoardSizeOrder])
  const [boardSizeReordering,setBoardSizeReordering]=useState(false)
  const [subcontractorRates,setSubcontractorRates]=useState<RateBook>(()=>defaultSubcontractorRates(initialCategories))
  const [clearedSubcontractorRates,setClearedSubcontractorRates]=useState<string[]>([])
  const [contractorUnlocked,setContractorUnlocked]=useState(false)
  const [contractorLoginId,setContractorLoginId]=useState('')
  const [contractorPassword,setContractorPassword]=useState('')
  const [contractorLoginError,setContractorLoginError]=useState('')
  const [hoveredMeasurementId,setHoveredMeasurementId]=useState<string|null>(null)
  const [contractorRates,setContractorRates]=useState<RateBook>({})
  const [rateDrafts,setRateDrafts]=useState<Record<string,string>>({})
  const [boardTarget,setBoardTarget]=useState<BoardTarget | null>(null)
  const [boardStep,setBoardStep]=useState<'type'|'thickness'|'size'>('type')
  const [boardDraftType,setBoardDraftType]=useState<BoardType>('STD')
  const [boardDraftThickness,setBoardDraftThickness]=useState(15)
  const [boardDraftOverride,setBoardDraftOverride]=useState<number | undefined>()
  const [boardPendingSize,setBoardPendingSize]=useState<[number,number] | null>(null)
  const [boardPendingSpec,setBoardPendingSpec]=useState<BoardSpec | null>(null)
  const [pointTrade,setPointTrade]=useState<PointTrade>('Tack')
  const [pointMarkerKind,setPointMarkerKind]=useState<PointMarkerKind>('marker')
  const [pointOptionsOpen,setPointOptionsOpen]=useState(false)
  const [boardPosition,setBoardPosition]=useState<Point>({x:8,y:100})
  const boardTriggerRef=useRef<HTMLButtonElement | null>(null)
  const [reorderDescriptions,setReorderDescriptions]=useState(false)
  const [calibrationVisible,setCalibrationVisible]=useState(true)
  const [hoverHeading,setHoverHeading]=useState<WorkHeading | 'Other' | null>(null)
  const descriptionSubmenuRef=useRef<HTMLDivElement | null>(null)
  const [submenuTop,setSubmenuTop]=useState(0)
  const [newDescriptionOpen,setNewDescriptionOpen]=useState(false)
  const [newDescriptionName,setNewDescriptionName]=useState('')
  const [newDescriptionHeading,setNewDescriptionHeading]=useState<WorkHeading>('Tack')
  const [newDescriptionMode,setNewDescriptionMode]=useState<'measure'|'count'>('measure')
  const [newDescriptionSkim,setNewDescriptionSkim]=useState<'none'|'ceilings'|'walls'>('none')
  const [newDescriptionError,setNewDescriptionError]=useState('')
  const [messagesHidden,setMessagesHidden]=useState(true)
  const [isolatedMeasurementId,setIsolatedMeasurementId]=useState<string | null>(null)
  const [duplicateRequest,setDuplicateRequest]=useState<{ids:string[];page:number;title:string;categoryId:string} | null>(null)
  const [duplicatePage,setDuplicatePage]=useState(1)
  const [duplicateKeepDescription,setDuplicateKeepDescription]=useState(true)
  const [duplicateCategoryId,setDuplicateCategoryId]=useState('')
  const [duplicateError,setDuplicateError]=useState('')
  const [duplicating,setDuplicating]=useState(false)
  const duplicateBusyRef=useRef(false)
  const toolboxRef = useRef<HTMLDivElement | null>(null)
  const workspaceRef = useRef<HTMLElement | null>(null)
  const toolboxDragRef = useRef<{ id: number; x: number; y: number; origin: Point; moved: boolean } | null>(null)
  const [snapEnabled, setSnapEnabled] = useState(false)
  const [snapSource, setSnapSource] = useState<'both' | 'pdf' | 'measure'>('both')
  const [snapEndpoints, setSnapEndpoints] = useState(true)
  const [snapMidpoints, setSnapMidpoints] = useState(true)
  const [snapPreview, setSnapPreview] = useState<SnapTarget | null>(null)
  const [pdfSnapInfo, setPdfSnapInfo] = useState('Import a drawing to use PDF snapping.')
  const pdfSnapCache = useRef<{ doc: PdfDoc | null; pages: Map<number, SnapIndex> }>({ doc: null, pages: new Map() })
  const [toolWallHeight, setToolWallHeight] = useState('')
  const [toolDoorHead,setToolDoorHead]=useState(false)
  const [materialTrade,setMaterialTrade]=useState<MaterialTrade>('all')
  const [materialDrawingKey,setMaterialDrawingKey]=useState('all')
  const [tabletLandscape,setTabletLandscape]=useState(()=>typeof navigator!=='undefined' && typeof window!=='undefined' && isIpadLandscape(navigator.userAgent,navigator.platform,navigator.maxTouchPoints,window.innerWidth,window.innerHeight))
  const [tabletSidebarOpen,setTabletSidebarOpen]=useState(true)
  const [materialWasteText,setMaterialWasteText]=useState('10')
  const [materialWasteDrafts,setMaterialWasteDrafts]=useState<Record<string,string>>({})
  const [insulationCoverageTexts,setInsulationCoverageTexts]=useState<Record<string,string>>({'50':'15.6','65':'12','100':'11','200':'6'})
  const [adhesiveCoverageText,setAdhesiveCoverageText]=useState('8.5')
  const [skimCoverageText,setSkimCoverageText]=useState('15')
  const [readyToolKind, setReadyToolKind] = useState<MeasurementKind | null>(null)
  const [overviewDrawing, setOverviewDrawing] = useState(false)
  const [groupHeightDrafts, setGroupHeightDrafts] = useState<Record<string, string>>({})
  const [workMenu, setWorkMenu] = useState<{ groupId: string; x: number; y: number; scopePage?: number } | null>(null)
  const [measurementMenu, setMeasurementMenu] = useState<{ id: string; kind: MeasurementKind; x: number; y: number; pointIndex?: number } | null>(null)
  const shiftHeldRef = useRef(false)
  const [selectedEditPoint, setSelectedEditPoint] = useState<SelectedEditPoint | null>(null)
  const [customFieldOpen, setCustomFieldOpen] = useState(false)
  const [pageDeletePrompt, setPageDeletePrompt] = useState<{number:number;source:number;page:number;name:string;x:number;y:number} | null>(null)
  const countSessionIdsRef = useRef<string[]>([])
  const [toolCustomName, setToolCustomName] = useState('')
  const [toolSwitchNotice, setToolSwitchNotice] = useState('')
  const lastMeasureToolRef = useRef<MeasurementKind>('run')
  const toolHeightInvalid = toolWallHeight !== '' && (!Number.isFinite(Number(toolWallHeight)) || Number(toolWallHeight) <= 0)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stageRef = useRef<HTMLElement | null>(null)
  const renderTaskRef = useRef<any>(null)
  const viewportRef = useRef<any>(null)
  const drawingRef = useRef<HTMLDivElement | null>(null)
  const calibrationDragRef = useRef<{
    point: 'A' | 'B' | null
    pointerId: number
  }>({
    point: null,
    pointerId: -1,
  })

  const lengthDragRef = useRef<{
    point: 'A' | 'B' | null
    measurementId: string | null
    pointerId: number
  }>({
    point: null,
    measurementId: null,
    pointerId: -1,
  })

  const nextLengthNumberRef = useRef(1)
  const nextRunNumberRef = useRef(1)
  const nextGroupNumberRef = useRef(1)
  const nextAreaNumberRef = useRef(1)
  const nextCountNumberRef = useRef(1)
  const countDragRef = useRef<{ countId: string; pointerId: number } | null>(null)
  const areaDragRef = useRef<{ areaId: string; pointIndex: number; pointerId: number } | null>(null)
  const runDragRef = useRef<{
    runId: string; pointIndex: number; pointerId: number
  } | null>(null)
  const pdfBytesRef = useRef<Uint8Array | null>(null)
  const fileBusyRef = useRef(false)

  const panStartRef = useRef({
    active: false,
    moved: false,
    pointerId: -1,
    clientX: 0,
    clientY: 0,
    panX: 0,
    panY: 0,
  })

  const [drawingSources, setDrawingSources] = useState<DrawingSource[]>([])
  const [drawingPages, setDrawingPages] = useState<DrawingPage[]>([])
  const [toolCalibrationNotice, setToolCalibrationNotice] = useState('')
  const [pdf, setPdf] = useState<PdfDoc | null>(null)
  const [fileName, setFileName] = useState('')
  const [job, setJob] = useState<JobDetails>({ ...emptyJob })
  const [isFileBusy, setIsFileBusy] = useState(false)
  const [savedSignature, setSavedSignature] = useState<string | null>(null)
  const [lastSavedAt, setLastSavedAt] = useState('')
  const [pageNumber, setPageNumber] = useState(1)

  const [scale, setScale] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [viewMode, setViewMode] = useState<ViewMode>('fit-page')
  const [stageResizeTick, setStageResizeTick] = useState(0)

  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)

  const [viewportSize, setViewportSize] = useState({
    width: 0,
    height: 0,
  })

  const [status, setStatus] = useState('Upload a PDF drawing to begin.')

  const [calibrationMode, setCalibrationMode] = useState(false)
  const [calibrationPoints, setCalibrationPoints] = useState<Point[]>([])
  const [pendingCalibration, setPendingCalibration] =
    useState<{ pointA: Point; pointB: Point } | null>(null)
  const [calibrationDistance, setCalibrationDistance] = useState('')
  const [recalibrationDistance, setRecalibrationDistance] = useState('')
  const [calibrations, setCalibrations] = useState<Record<number, Calibration>>({})

  const [lengthMode, setLengthMode] = useState(false)
  const [lengthPoints, setLengthPoints] = useState<Point[]>([])
  const [lengthMeasurements, setLengthMeasurements] =
    useState<Record<number, LengthMeasurement[]>>({})
  const [runMode, setRunMode] = useState(false)
  const [runPoints, setRunPoints] = useState<Point[]>([])
  const [runMeasurements, setRunMeasurements] =
    useState<Record<number, RunMeasurement[]>>({})
  const [groups, setGroups] = useState<MeasurementGroup[]>([])
  const [newGroupName, setNewGroupName] = useState('')
  const [activeGroupId, setActiveGroupId] = useState('')
  const [areaMode, setAreaMode] = useState(false)
  const [areaPoints, setAreaPoints] = useState<Point[]>([])
  const [areaMeasurements, setAreaMeasurements] = useState<Record<number, AreaMeasurement[]>>({})
  const [heightDrafts, setHeightDrafts] = useState<Record<string, string>>({})
  const [categories, setCategories] = useState<WorkCategory[]>(() => initialCategories.map((category) => ({ ...category })))
  const [countMeasurements, setCountMeasurements] = useState<Record<number, CountMeasurement[]>>({})
  const [countMode, setCountMode] = useState(false)
  const [hiddenGroupIds, setHiddenGroupIds] = useState<string[]>([])
  const [showUngrouped, setShowUngrouped] = useState(true)
  const [summaryPresentation,setSummaryPresentation]=useState<'detailed'|'simplified'>('detailed')
  const [sidebarTab, setSidebarTab] = useState<'measure' | 'groups' | 'summary' | 'contractor-rates' | 'rates' | 'materials' | 'export'>('measure')
  const [newCategoryName, setNewCategoryName] = useState('')
  const [newCategoryColor, setNewCategoryColor] = useState('#0891b2')
  const [newCategoryMode, setNewCategoryMode] = useState<'measure' | 'count'>('measure')
  const [measurementChooser, setMeasurementChooser] = useState<MeasurementKind | null>(null)
  const [chooserCategoryId, setChooserCategoryId] = useState('')
  const [chooserGroupId, setChooserGroupId] = useState('__new__')
  const [chooserGroupName, setChooserGroupName] = useState('')
  const [queuedStart, setQueuedStart] = useState<MeasurementKind | null>(null)
  const [heightPromptOpen, setHeightPromptOpen] = useState(false)
  const [startingWallHeight, setStartingWallHeight] = useState('')
  const [runHeightM, setRunHeightM] = useState<number | undefined>(undefined)
  const [viewCategoryId, setViewCategoryId] = useState('')
  const [viewGroupId, setViewGroupId] = useState('')
  const [selectedWorkId, setSelectedWorkId] = useState<string | null>(null)
  const [showCalibrationWarning, setShowCalibrationWarning] = useState(false)
  const calibrationDockRef = useRef<HTMLElement | null>(null)
  const activeGroup = groups.find((group) => group.id === activeGroupId)
  const activeCategory = categories.find((category) => category.id === activeGroup?.categoryId)
  const activeIsCount = activeCategory?.mode === 'count'
  const pageCalibration = calibrations[pageNumber]
  const calibrationIssue = !pageCalibration ? 'missing' : pageCalibration.needsRecalibration ? 'changed' : !pageCalibration.locked ? 'unlocked' : 'ready'

  useEffect(() => {
    if (pdf && !isFileBusy && calibrationIssue !== 'ready') setShowCalibrationWarning(true)
    else setShowCalibrationWarning(false)
  }, [pdf, pageNumber, calibrationIssue, isFileBusy])

  function reviewCalibration() {
    setShowCalibrationWarning(false)
    if (calibrationIssue === 'missing') startCalibration()
    else calibrationDockRef.current?.querySelector<HTMLInputElement>('input[type="number"]')?.focus()
  }
  useEffect(() => { setToolCalibrationNotice('') }, [pdf, pageNumber, calibrations])
  const wallIds = new Set([...Object.values(lengthMeasurements).flat(), ...Object.values(runMeasurements).flat()].map((item) => item.id))
  const hasInvalidHeight = toolHeightInvalid || Object.entries(groupHeightDrafts).some(([id, text]) => groups.some((group) => group.id === id.split(':')[0]) && text !== '' && (!Number.isFinite(Number(text)) || Number(text) <= 0)) || Object.entries(heightDrafts).some(([id, text]) => wallIds.has(id)
    && text !== '' && (!Number.isFinite(Number(text)) || Number(text) <= 0))

  const validWaste=(text:string)=>text.trim()!=='' && Number.isFinite(Number(text)) && Number(text)>=0
  const hasInvalidWaste=!validWaste(materialWasteText) || Object.values(materialWasteDrafts).some(text=>!validWaste(text))
  const materialWasteOverrides=Object.fromEntries(Object.entries(materialWasteDrafts).filter(([,text])=>validWaste(text)).map(([key,text])=>[key,Number(text)]))
  const materialWastePercent=validWaste(materialWasteText) ? Number(materialWasteText) : 0
  const coverageWork=[...Object.values(lengthMeasurements).flat(),...Object.values(runMeasurements).flat(),...Object.values(areaMeasurements).flat()]
  const usedInsulationThicknesses=new Set(coverageWork.filter(item=>item.boardSpec?.boardType==='INS').map(item=>String(item.boardSpec!.thicknessMm)))
  const coverageSources=coverageWork.map(item=>{const group=groups.find(group=>group.id===item.groupId),category=categories.find(category=>category.id===group?.categoryId);return {group,category}})
  const adhesiveCoverageUsed=coverageSources.some(({category})=>category && categoryWorkHeading(category)==='Dab')
  const skimCoverageUsed=coverageSources.some(({group,category})=>category && (categoryWorkHeading(category)==='Skim' || group?.includeSkim!==false && !!category.skimTarget))
  const hasInvalidCoverage=[...(adhesiveCoverageUsed ? [adhesiveCoverageText] : []),...(skimCoverageUsed ? [skimCoverageText] : []),...Array.from(usedInsulationThicknesses,thickness=>insulationCoverageTexts[thickness])].some(text=>text.trim()==='' || !Number.isFinite(Number(text)) || Number(text)<=0)
  const coverageValue=(text:string,fallback:number,used:boolean)=>!used && (!Number.isFinite(Number(text)) || Number(text)<=0) ? fallback : Number.isFinite(Number(text)) ? Number(text) : 0
  const materialCoverage:MaterialCoverage={adhesive:coverageValue(adhesiveCoverageText,8.5,adhesiveCoverageUsed),skim:coverageValue(skimCoverageText,15,skimCoverageUsed),insulation:Object.fromEntries(Object.entries(insulationCoverageTexts).map(([key,text])=>[key,coverageValue(text,defaultInsulationCoverage[key],usedInsulationThicknesses.has(key))]))}
  const hasInvalidRates=Object.values(rateDrafts).some(text=>text!=='' && !validRateText(text))

  // View changes do not mark measurements as changed, but the view is saved too.
  const dataSignature = JSON.stringify({ job, drawingPages, calibrations, lengths: lengthMeasurements,
    runs: runMeasurements, nextLengthNumber: nextLengthNumberRef.current,
    nextRunNumber: nextRunNumberRef.current, groups, nextGroupNumber: nextGroupNumberRef.current,
    areas: areaMeasurements, nextAreaNumber: nextAreaNumberRef.current,
    counts: countMeasurements, nextCountNumber: nextCountNumberRef.current, categories, subcontractorRates, clearedSubcontractorRates, contractorRates, boardSizeOrder, materialWastePercent, materialWasteOverrides, materialCoverage })
  const hasDraft = runMode || lengthMode || areaMode || countMode || calibrationMode || !!pendingCalibration
  const hasUnsavedChanges = (savedSignature === null
    ? !!pdf || Object.values(job).some(Boolean)
    : savedSignature !== dataSignature) || hasDraft || hasInvalidHeight || hasInvalidRates || hasInvalidWaste || hasInvalidCoverage

  useEffect(() => {
    if (queuedStart) beginQueuedMeasurement()
  }, [queuedStart])

  useEffect(() => {
    if (!runMode && !areaMode && !countMode && !lengthMode && !readyToolKind) return
    window.addEventListener('keydown', finishWithEnter)
    return () => window.removeEventListener('keydown', finishWithEnter)
  }, [runMode, runPoints, areaMode, areaPoints, countMode, lengthMode, measurementChooser, calibrations, pageNumber, runHeightM, toolHeightInvalid, activeGroupId, heightPromptOpen, lengthPoints, readyToolKind])

  function finishWithEnter(event: KeyboardEvent) {
    if (event.key === 'Escape' && !measurementChooser && !heightPromptOpen) { event.preventDefault(); stopMeasurement(); return }
    if (event.key !== 'Enter' || event.repeat || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || measurementChooser || heightPromptOpen) return
    const target = event.target as HTMLElement | null
    if (target?.closest?.('input, textarea, select, button, a, summary, [contenteditable="true"], [role="button"]')) return
    if (!runMode && !areaMode && !countMode && !lengthMode) return
    event.preventDefault()
    if (runMode) {
      if (runPoints.length < 2) setStatus('Place at least two points before finishing the run.')
      else finishRun()
    } else if (areaMode) finishArea()
    else if (countMode) finishCounting()
    else setStatus('Place the second point to finish this length. Single lengths finish automatically.')
  }

  useEffect(() => {
    if (!hasUnsavedChanges) return
    function warnBeforeLeaving(event: BeforeUnloadEvent) {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeLeaving)
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving)
  }, [hasUnsavedChanges])

  function allowReplacingTakeoff() {
    return !hasUnsavedChanges || window.confirm('You have work that has not been saved. Replace it? Cancel and use Save Measure to keep it first.')
  }

  function resetDrafts() {
    setMaterialTrade('all');setMaterialDrawingKey('all');setTabletSidebarOpen(true)
    setContractorUnlocked(false);setContractorLoginId('');setContractorPassword('');setContractorLoginError('');setHoveredMeasurementId(null)
    setDrawingRenderError('');setDrawingRendering(false)
    setSelectedWorkId(null)
    setReadyToolKind(null)
    setOverviewDrawing(false)
    setGroupHeightDrafts({})
    setMeasurementMenu(null)
    setWorkMenu(null)
    setToolCustomName('')
    setToolDoorHead(false);setMaterialWasteText('10');setMaterialWasteDrafts({});setInsulationCoverageTexts({'50':'15.6','65':'12','100':'11','200':'6'});setAdhesiveCoverageText('8.5');setSkimCoverageText('15')
    setSubcontractorRates(defaultSubcontractorRates(initialCategories));setClearedSubcontractorRates([]);setContractorRates({});setRateDrafts({});setBoardSizeOrder([...defaultBoardSizeOrder]);setBoardSizeReordering(false)
    setSummaryPresentation('detailed')
    setPointTrade('Tack');setPointMarkerKind('marker');setPointOptionsOpen(false)
    setBoardPreferences({});setBoardPickerOpen(false);setBoardTarget(null);setBoardPendingSpec(null);setBoardPendingSize(null)
    setNewDescriptionOpen(false);setHoverHeading(null);setMessagesHidden(true);setDescriptionOpen(false);setReorderDescriptions(false);setSnapEnabled(false);setToolboxDocked(true);setPanelMenu(null);setCalibrationVisible(true)
    setIsolatedMeasurementId(null);setDuplicateRequest(null)
    setSelectedEditPoint(null)
    setPageDeletePrompt(null)
    setToolSwitchNotice('')
    setShowCalibrationWarning(false)
    setHeightPromptOpen(false)
    setStartingWallHeight('')
    setRunHeightM(undefined)
    setMeasurementChooser(null)
    setQueuedStart(null)
    setCountMode(false)
    countDragRef.current = null
    setAreaMode(false)
    setAreaPoints([])
    setHeightDrafts({})
    areaDragRef.current = null
    setCalibrationMode(false)
    setCalibrationPoints([])
    setPendingCalibration(null)
    setCalibrationDistance('')
    setRecalibrationDistance('')
    setLengthMode(false)
    setLengthPoints([])
    setRunMode(false)
    setRunPoints([])
    runDragRef.current = null
    calibrationDragRef.current = { point: null, pointerId: -1 }
    lengthDragRef.current = { point: null, measurementId: null, pointerId: -1 }
    panStartRef.current.active = false
    setIsPanning(false)
  }

  function saveTakeoff() {
    if (!pdf || !pdfBytesRef.current || fileBusyRef.current) return
    if(hasInvalidCoverage){setStatus('Enter positive material coverage values before saving.');return}
    if(hasInvalidWaste){setStatus('Enter valid material waste percentages before saving.');return}
    if(hasInvalidRates){setStatus('Correct or clear the invalid rate before saving.');return}
    if (hasDraft || hasInvalidHeight) {
      if (hasInvalidHeight) {
        setStatus('Enter a wall height greater than zero, or clear the height field before saving.')
        return
      }
      setStatus('Finish or cancel the current measurement or calibration before saving.')
      return
    }
    try {
      const savedAt = new Date().toISOString()
      const takeoff: TakeoffFile = {
        format: 'drylining-takeoff', version: 8, savedAt,
        drawing: { name: fileName, pdfBase64: encodePdf(pdfBytesRef.current), additionalPdfs: drawingSources.slice(1).map((source) => ({ name: source.name, pdfBase64: encodePdf(source.bytes) })), pages: drawingPages },
        job: { ...job }, calibrations, lengths: lengthMeasurements, runs: runMeasurements,
        nextLengthNumber: nextLengthNumberRef.current, nextRunNumber: nextRunNumberRef.current,
        groups, nextGroupNumber: nextGroupNumberRef.current,
        areas: areaMeasurements, nextAreaNumber: nextAreaNumberRef.current,
        counts: countMeasurements, nextCountNumber: nextCountNumberRef.current, categories, subcontractorRates, clearedSubcontractorRates, contractorRates, boardSizeOrder, materialWastePercent, materialWasteOverrides, materialCoverage,
        view: { page: pageNumber, rotation, mode: viewMode, scale, pan, hiddenGroupIds, showUngrouped, categoryId: viewCategoryId, groupId: viewGroupId },
      }
      const blob = new Blob([JSON.stringify(takeoff)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      const name = [job.site, job.plot].filter(Boolean).join('-') || fileName.replace(/\.pdf$/i, '')
      link.href = url
      link.download = `${name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 100) || 'drawing'}.takeoff.json`
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 60000)
      setSavedSignature(dataSignature)
      setLastSavedAt(savedAt)
      setStatus('Take-off download started. Keep the .takeoff.json file; it includes your drawing and all saved measurements.')
    } catch (error) {
      console.error(error)
      setStatus('Could not save the take-off. Your work is still open; please try again.')
    }
  }

  async function openTakeoff(file: File) {
    if (fileBusyRef.current || !allowReplacingTakeoff()) return
    fileBusyRef.current = true
    setIsFileBusy(true)
    setStatus('Opening saved take-off…')
    let loadedPdf: PdfDoc | null = null
    let loadedSources: DrawingSource[] = []
    try {
      let raw: unknown
      try { raw = JSON.parse(await file.text()) }
      catch { throw new Error('This is not a readable take-off file. Your current work has been kept.') }
      const saved = readTakeoff(raw)
      const bytes = decodePdf(saved.drawing.pdfBase64)
      // PDF.js may transfer its input buffer to the worker. Keep our own copy for saving again.
      const primaryDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise
      loadedSources.push({ name: saved.drawing.name, bytes, doc: primaryDoc })
      for (const source of saved.drawing.additionalPdfs ?? []) {
        const extraBytes = decodePdf(source.pdfBase64)
        const doc = await pdfjsLib.getDocument({ data: extraBytes.slice() }).promise
        loadedSources.push({ name: source.name, bytes: extraBytes, doc })
      }
      const restoredPages = saved.drawing.pages ?? defaultDrawingPages(loadedSources[0])
      if (restoredPages.some((page) => page.page > loadedSources[page.source].doc.numPages)) throw new Error('A saved drawing page is missing. Your current work has been kept.')
      loadedPdf = drawingSet(loadedSources, restoredPages)
      const pages = [...Object.keys(saved.calibrations), ...Object.keys(saved.lengths), ...Object.keys(saved.runs), ...Object.keys(saved.areas), ...Object.keys(saved.counts)]
      if (saved.view.page > loadedPdf.numPages || pages.some((key) => Number(key) > loadedPdf!.numPages)) {
        throw new Error('The saved measurements refer to a missing PDF page. Your current work has been kept.')
      }
      resetDrafts()
      pdfBytesRef.current = bytes
      setPdf(loadedPdf)
      setDrawingSources(loadedSources)
      setDrawingPages(restoredPages)
      setFileName(saved.drawing.name)
      setJob(saved.job)
      setCalibrations(saved.calibrations)
      setLengthMeasurements(saved.lengths)
      setRunMeasurements(saved.runs)
      setAreaMeasurements(saved.areas)
      setCategories(saved.categories)
      setSubcontractorRates(saved.subcontractorRates);setClearedSubcontractorRates(saved.clearedSubcontractorRates);setContractorRates(saved.contractorRates);setBoardSizeOrder(saved.boardSizeOrder);setMaterialWasteText(String(saved.materialWastePercent));setMaterialWasteDrafts(Object.fromEntries(Object.entries(saved.materialWasteOverrides).map(([key,value])=>[key,String(value)])));setInsulationCoverageTexts(Object.fromEntries(Object.entries(saved.materialCoverage.insulation).map(([key,value])=>[key,String(value)])));setAdhesiveCoverageText(String(saved.materialCoverage.adhesive));setSkimCoverageText(String(saved.materialCoverage.skim))
      setCountMeasurements(saved.counts)
      nextCountNumberRef.current = saved.nextCountNumber
      setHiddenGroupIds([])
      setShowUngrouped(true)
      setViewCategoryId('')
      setViewGroupId('')
      setOverviewDrawing(true)
      setSidebarTab('summary')
      setNewCategoryName('')
      nextAreaNumberRef.current = saved.nextAreaNumber
      setGroups(saved.groups)
      setActiveGroupId('')
      setNewGroupName('')
      nextGroupNumberRef.current = saved.nextGroupNumber
      nextLengthNumberRef.current = saved.nextLengthNumber
      nextRunNumberRef.current = saved.nextRunNumber
      setPageNumber(saved.view.page)
      setRotation(saved.view.rotation)
      setViewMode(saved.view.mode)
      setScale(saved.view.scale)
      setPan(saved.view.pan)
      setStageResizeTick((tick) => tick + 1)
      setSavedSignature(JSON.stringify({ job: saved.job, drawingPages: restoredPages, calibrations: saved.calibrations,
        lengths: saved.lengths, runs: saved.runs, nextLengthNumber: saved.nextLengthNumber,
        nextRunNumber: saved.nextRunNumber, groups: saved.groups, nextGroupNumber: saved.nextGroupNumber,
        areas: saved.areas, nextAreaNumber: saved.nextAreaNumber,
        counts: saved.counts, nextCountNumber: saved.nextCountNumber, categories: saved.categories, subcontractorRates:saved.subcontractorRates, clearedSubcontractorRates:saved.clearedSubcontractorRates, contractorRates:saved.contractorRates, boardSizeOrder:saved.boardSizeOrder, materialWastePercent:saved.materialWastePercent, materialWasteOverrides:saved.materialWasteOverrides, materialCoverage:saved.materialCoverage }))
      setLastSavedAt(saved.savedAt)
      setStatus(`Opened ${file.name}. Your drawing, job details and measurements are restored.`)
      loadedPdf = null // Ownership has passed to the viewer.
      loadedSources = []
    } catch (error) {
      console.error(error)
      setStatus(error instanceof Error ? error.message : 'Could not open that take-off. Your current work has been kept.')
    } finally {
      if (loadedSources.length) void Promise.all(loadedSources.map((source) => source.doc.destroy()))
      fileBusyRef.current = false
      setIsFileBusy(false)
    }
  }

  async function openPdf(file: File) {
    if (fileBusyRef.current || !allowReplacingTakeoff()) return
    fileBusyRef.current = true
    setIsFileBusy(true)
    try {
      setStatus('Loading drawing…')

      const bytes = new Uint8Array(await file.arrayBuffer())
      const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise
      const sources = [{ name: file.name, bytes, doc }]
      const pages = defaultDrawingPages(sources[0])
      const loadedPdf = drawingSet(sources, pages)

      pdfBytesRef.current = bytes
      setDrawingSources(sources)
      setDrawingPages(pages)
      resetDrafts()
      setPdf(loadedPdf)
      setFileName(file.name)
      setJob({ ...emptyJob })
      setAreaMeasurements({})
      setCountMeasurements({})
      nextCountNumberRef.current = 1
      setCategories(initialCategories.map((category) => ({ ...category })))
      setHiddenGroupIds([])
      setShowUngrouped(true)
      setViewCategoryId('')
      setViewGroupId('')
      setSidebarTab('measure')
      setNewCategoryName('')
      nextAreaNumberRef.current = 1
      setGroups([])
      setActiveGroupId('')
      setNewGroupName('')
      nextGroupNumberRef.current = 1
      setSavedSignature(null)
      setLastSavedAt('')
      setPageNumber(1)
      setRotation(0)
      setViewMode('fit-page')
      setPan({ x: 0, y: 0 })
      setCalibrationMode(false)
      setCalibrationPoints([])
      setPendingCalibration(null)
      setCalibrationDistance('')
      setRecalibrationDistance('')
      setCalibrations({})
      setLengthMode(false)
      setLengthPoints([])
      setLengthMeasurements({})
      nextLengthNumberRef.current = 1
      setRunMode(false)
      setRunPoints([])
      setRunMeasurements({})
      nextRunNumberRef.current = 1
      runDragRef.current = null

      setStatus(
        `Loaded ${loadedPdf.numPages} page${loadedPdf.numPages === 1 ? '' : 's'}.`
      )
    } catch (error) {
      console.error(error)
      setStatus('Could not open that PDF. Try another file.')
    } finally {
      fileBusyRef.current = false
      setIsFileBusy(false)
    }
  }

  async function importDrawingPages(files: File[]) {
    if (!files.length || !pdf || fileBusyRef.current) return
    stopMeasurement()
    fileBusyRef.current = true; setIsFileBusy(true)
    const additions: DrawingSource[] = []
    try {
      setStatus('Importing drawing pages…')
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise
        additions.push({ name: file.name, bytes, doc })
      }
      const sources = [...drawingSources, ...additions]
      const pages = [...drawingPages, ...additions.flatMap((source, i) => defaultDrawingPages(source, drawingSources.length + i))]
      const nextPdf = drawingSet(sources, pages)
      const cachedPages = pdfSnapCache.current.doc === pdf ? pdfSnapCache.current.pages : new Map<number, SnapIndex>()
      pdfSnapCache.current = { doc: nextPdf, pages: new Map(cachedPages) }
      setDrawingSources(sources); setDrawingPages(pages); setPdf(nextPdf)
      setDescriptionOpen(false);setHoverHeading(null);setReorderDescriptions(false);setMessagesHidden(true);setSnapEnabled(false);setToolboxDocked(true);setPanelMenu(null)
      setPageNumber(drawingPages.length + 1); setViewMode('fit-page'); setPan({ x: 0, y: 0 })
      setStatus(`Added ${pages.length - drawingPages.length} drawing pages. Existing measurements and calibration have been kept.`)
      additions.length = 0
    } catch (error) {
      console.error(error)
      setStatus('Could not import those drawing pages. Existing drawings and measurements have been kept.')
    } finally {
      if (additions.length) void Promise.all(additions.map((source) => source.doc.destroy()))
      fileBusyRef.current = false; setIsFileBusy(false)
    }
  }

  function renameDrawingPage(number: number, name: string) {
    const trimmed = name.trim().slice(0, 80)
    if (!trimmed || !drawingPages[number - 1]) return
    setDrawingPages((current) => current.map((page, index) => index === number - 1 ? { ...page, name: trimmed } : page))
  }

  function goToDrawingPage(number: number) {
    setIsolatedMeasurementId(null)
    if (!pdf || fileBusyRef.current || number < 1 || number > drawingPages.length) return
    stopMeasurement()
    setPageNumber(number); setViewMode('fit-page'); setPan({ x: 0, y: 0 })
    if (sidebarTab === 'groups') {
      setSelectedWorkId('__all__'); setViewGroupId(''); setViewCategoryId(''); setHiddenGroupIds([]); setShowUngrouped(true); setOverviewDrawing(true)
    }
    setMeasurementMenu(null); setWorkMenu(null)
  }

  function deleteDrawingPage(number: number, confirmed = false) {
    if (fileBusyRef.current || !drawingPages[number - 1]) return
    if (drawingPages.length <= 1) { setStatus('Keep at least one drawing page. Import another page before removing this one.'); return }
    if (hasDraft) { setStatus('Finish or stop measuring before deleting a drawing page.'); return }
    const members = [...(lengthMeasurements[number] ?? []), ...(runMeasurements[number] ?? []), ...(areaMeasurements[number] ?? []), ...(countMeasurements[number] ?? [])]
    if (!confirmed && !window.confirm(`Delete "${drawingPageName(number)}"? Its ${members.length} measurements and calibration will also be removed. Other pages will be kept.`)) return
    stopMeasurement()
    const pages = drawingPages.filter((_, index) => index !== number - 1)
    const nextPdf = drawingSet(drawingSources, pages)
    const cached = pdfSnapCache.current.doc === pdf ? pdfSnapCache.current.pages : new Map<number, SnapIndex>()
    pdfSnapCache.current = { doc: nextPdf, pages: new Map([...cached].filter(([key]) => key !== number).map(([key, value]) => [key > number ? key - 1 : key, value])) }
    setCalibrations((current) => removePageRecord(current, number))
    setLengthMeasurements((current) => removePageRecord(current, number))
    setRunMeasurements((current) => removePageRecord(current, number))
    setAreaMeasurements((current) => removePageRecord(current, number))
    setCountMeasurements((current) => removePageRecord(current, number))
    setHeightDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !members.some((item) => item.id === id))))
    setGroupHeightDrafts((current) => Object.fromEntries(Object.entries(current).flatMap(([key,value]) => {
      const [id,page]=key.split(':'); if (!page) return [[key,value]]
      const numeric=Number(page); return numeric === number ? [] : [[id+':'+(numeric>number ? numeric-1 : numeric),value]]
    })))
    setDrawingPages(pages); setPdf(nextPdf)
    setPageNumber((current) => current > number ? current - 1 : Math.min(current, pages.length))
    setViewMode('fit-page'); setPan({ x: 0, y: 0 })
    setMeasurementMenu(null); setWorkMenu(null)
    setStatus('Drawing page deleted. Remaining pages keep their names, calibration and measurements.')
  }

  function requestPageDelete(number: number, target: HTMLElement) {
    if (drawingPages.length<=1 || hasDraft || fileBusyRef.current) return
    const page=drawingPages[number-1], rect=target.getBoundingClientRect()
    if (!page) return
    const width=window.innerWidth || 1200,height=window.innerHeight || 800
    setPageDeletePrompt({number,source:page.source,page:page.page,name:page.name,x:Math.max(8,Math.min(rect.right+8,width-270)),y:Math.max(8,Math.min(rect.top,height-180))})
  }
  function confirmPageDelete() {
    if (!pageDeletePrompt) return
    const page=drawingPages[pageDeletePrompt.number-1]
    if (page?.source===pageDeletePrompt.source && page.page===pageDeletePrompt.page) deleteDrawingPage(pageDeletePrompt.number,true)
    setPageDeletePrompt(null)
  }

  function measurementToolHelp() {
    return !pdf ? 'Import a drawing, then calibrate this drawing page before starting measurements.'
      : !hasValidCalibration() ? 'Calibrate this drawing page before starting measurements.'
      : 'Finish the calibration and lock it before starting measurements.'
  }

  function activateMeasurementTool(kind: MeasurementKind) {
    if (!pdf || !hasValidCalibration() || calibrationMode || pendingCalibration) {
      setToolCalibrationNotice(measurementToolHelp())
      if (pdf && !hasValidCalibration()) setShowCalibrationWarning(true)
      return
    }
    setToolCalibrationNotice('')
    if(kind==='point') {
      setPointOptionsOpen(true)
      const current=categories.find(category=>category.id===(chooserCategoryId || activeCategory?.id))
      if(current?.mode==='count' && !current.id.startsWith('point-')) {startToolMeasurement(kind);return}
      selectPointMarker(pointTrade,pointMarkerKind);return
    }
    setPointOptionsOpen(false);startToolMeasurement(kind)
  }
  function selectPointMarker(trade:PointTrade,kind:PointMarkerKind) {
    if(!pdf || !hasValidCalibration() || calibrationMode || pendingCalibration){setToolCalibrationNotice(measurementToolHelp());return}
    if(queuedStart || !finishToolBeforeSwitch())return
    const id='point-'+kind+'-'+trade.toLowerCase()
    if(!toolDestination('point',id,''))return
    setPointTrade(trade);setPointMarkerKind(kind);setPointOptionsOpen(true);setToolDoorHead(false)
    setQueuedStart('point');setToolboxOpen(true);setDescriptionOpen(false)
    setStatus(trade+' · '+pointMarkerLabels[kind]+': click once at each location. Press Enter when finished.')
  }


  async function calculateFitPageScale(
    document: PdfDoc,
    pageNo: number,
    pageRotation: number
  ) {
    const stage = stageRef.current
    if (!stage) return scale

    const page = await document.getPage(pageNo)

    const baseViewport = page.getViewport({
      scale: 1,
      rotation: pageRotation,
    })

    const padding = 32
    const availableWidth = Math.max(100, stage.clientWidth - padding * 2)
    const availableHeight = Math.max(100, stage.clientHeight - padding * 2)

    return Math.min(
      availableWidth / baseViewport.width,
      availableHeight / baseViewport.height
    )
  }

  function fitPage() {
    if (!pdf) return

    setViewMode('fit-page')
    setPan({ x: 0, y: 0 })
    setStageResizeTick((tick) => tick + 1)
  }

  function rotateLeft() {
    if (!pdf) return

    setRotation((current) => (current + 270) % 360)
    setViewMode('fit-page')
    setPan({ x: 0, y: 0 })
  }

  function rotateRight() {
    if (!pdf) return

    setRotation((current) => (current + 90) % 360)
    setViewMode('fit-page')
    setPan({ x: 0, y: 0 })
  }

  function previousPage() {
    if (!pdf || pageNumber <= 1 || runMode || areaMode) return

    if(sidebarTab==='groups') {goToDrawingPage(pageNumber-1);return}
    setPageNumber(current=>current-1);setViewMode('fit-page');setPan({x:0,y:0})
  }

  function nextPage() {
    if (!pdf || pageNumber >= pdf.numPages || runMode || areaMode) return

    if(sidebarTab==='groups') {goToDrawingPage(pageNumber+1);return}
    setPageNumber(current=>current+1);setViewMode('fit-page');setPan({x:0,y:0})
  }

  function handleZoomSlider(value: string) {
    const percent = Number(value)

    if (!Number.isFinite(percent)) return

    setViewMode('manual')
    setScale(percent / 100)
  }

  function startPan(event: React.PointerEvent<HTMLElement>) {
    setSelectedEditPoint(null);setDescriptionOpen(false)
    readShift(event)
    if (!pdf || event.button !== 0) return

    panStartRef.current = {
      active: true,
      moved: false,
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      panX: pan.x,
      panY: pan.y,
    }

    setIsPanning(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function movePan(event: React.PointerEvent<HTMLElement>) {
    const start = panStartRef.current

    if (!start.active || start.pointerId !== event.pointerId) return

    const dx = event.clientX - start.clientX
    const dy = event.clientY - start.clientY

    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
      start.moved = true
    }

    setPan({
      x: start.panX + dx,
      y: start.panY + dy,
    })
  }

  function addCalibrationPoint(clientX: number, clientY: number) {
    if (!calibrationMode) return

    const newPoint = clientToPdfPoint(clientX, clientY)
    if (!newPoint) return

    if (calibrationPoints.length === 0) {
      setCalibrationPoints([newPoint])
      setStatus(
        'Calibration: first point set. Pan or zoom as needed, then click the second point.'
      )
      return
    }

    const pointA = calibrationPoints[0]
    const pointB = newPoint

    setCalibrationPoints([pointA, pointB])
    setPendingCalibration({ pointA, pointB })
    setCalibrationDistance('')
    setCalibrationMode(false)

    setStatus(
      'Enter the known distance in millimetres to complete calibration.'
    )
  }

  function endPan(event: React.PointerEvent<HTMLElement>) {
    readShift(event)
    const start = panStartRef.current

    if (!start.active || start.pointerId !== event.pointerId) return

    const wasMoved = start.moved

    start.active = false
    setIsPanning(false)

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    if (!wasMoved) {
      if (calibrationMode) {
        addCalibrationPoint(event.clientX, event.clientY)
      } else if (runMode || readyToolKind === 'run') {
        addRunPoint(event.clientX, event.clientY)
      } else if (areaMode || readyToolKind === 'area') {
        addAreaPoint(event.clientX, event.clientY)
      } else if (countMode || readyToolKind === 'point') {
        addCountPoint(event.clientX, event.clientY)
      } else if (lengthMode || readyToolKind === 'length') {
        addLengthPoint(event.clientX, event.clientY)
      }
    }
  }

  function clientToPdfPoint(clientX: number, clientY: number): Point | null {
    if (!viewportRef.current || !drawingRef.current) return null

    const rect = drawingRef.current.getBoundingClientRect()
    const viewportX = clientX - rect.left
    const viewportY = clientY - rect.top

    if (
      viewportX < 0 ||
      viewportY < 0 ||
      viewportX > rect.width ||
      viewportY > rect.height
    ) {
      return null
    }

    const [pdfX, pdfY] =
      viewportRef.current.convertToPdfPoint(viewportX, viewportY)

    const point = { x: pdfX, y: pdfY }
    return resolvedPlacementPoint(point).point
  }

  const measurementSnapIndex = useMemo(() => {
    const segments: SnapSegment[] = []
    const chain = (points: Point[], closed = false) => {
      for (let i=1; i<points.length; i++) segments.push({ a: points[i-1], b: points[i] })
      if (closed && points.length > 2) segments.push({ a: points[points.length-1], b: points[0] })
    }
    const editingId = lengthDragRef.current.measurementId ?? runDragRef.current?.runId ?? areaDragRef.current?.areaId
    for (const item of lengthMeasurements[pageNumber] ?? []) if (item.id !== editingId && isMeasurementVisible(item.groupId, undefined, true, item.heightM)) chain([item.pointA,item.pointB])
    for (const item of runMeasurements[pageNumber] ?? []) if (item.id !== editingId && isMeasurementVisible(item.groupId, undefined, true, item.heightM)) chain(item.points)
    for (const item of areaMeasurements[pageNumber] ?? []) if (item.id !== editingId && isMeasurementVisible(item.groupId)) chain(item.points,true)
    return makeSnapIndex(segments, 'Measure')
  }, [lengthMeasurements, runMeasurements, areaMeasurements, pageNumber, viewGroupId, viewCategoryId, hiddenGroupIds, showUngrouped, groups])

  function snapForPoint(point: Point) {
    if (calibrationDragRef.current.point || lengthDragRef.current.point || runDragRef.current || areaDragRef.current || countDragRef.current) return null
    if (!snapEnabled || (!snapEndpoints && !snapMidpoints)) return null
    const indices: SnapIndex[] = []
    if (snapSource !== 'measure' && pdfSnapCache.current.doc === pdf) indices.push(pdfSnapCache.current.pages.get(pageNumber) ?? new Map())
    if (snapSource !== 'pdf') indices.push(measurementSnapIndex)
    return nearestSnap(point, indices, 10 / Math.max(scale, 0.01), snapEndpoints, snapMidpoints)
  }
  function constraintAnchor(): Point | null {
    const lengthDrag=lengthDragRef.current
    if (lengthDrag.point && lengthDrag.measurementId) { const item=(lengthMeasurements[pageNumber] ?? []).find(item=>item.id===lengthDrag.measurementId);return item ? lengthDrag.point==='A' ? item.pointB : item.pointA : null }
    const runDrag=runDragRef.current
    if (runDrag) {const item=(runMeasurements[pageNumber] ?? []).find(item=>item.id===runDrag.runId);return item?.points[runDrag.pointIndex>0 ? runDrag.pointIndex-1 : 1] ?? null}
    const areaDrag=areaDragRef.current
    if (areaDrag) {const item=(areaMeasurements[pageNumber] ?? []).find(item=>item.id===areaDrag.areaId);return item?.points[areaDrag.pointIndex>0 ? areaDrag.pointIndex-1 : 1] ?? null}
    if (calibrationDragRef.current.point) { const item=pendingCalibration ?? calibrations[pageNumber];return item ? calibrationDragRef.current.point==='A' ? item.pointB : item.pointA : null }
    if (runMode) return runPoints.at(-1) ?? null
    if (areaMode) return areaPoints.at(-1) ?? null
    if (lengthMode) return lengthPoints[0] ?? null
    if (calibrationMode) return calibrationPoints[0] ?? null
    return null
  }
  function resolvedPlacementPoint(point: Point) {
    const anchor=shiftHeldRef.current ? constraintAnchor() : null
    const constrained=anchor ? orthogonalPoint(point,anchor) : point
    let snap=snapForPoint(constrained)
    if (anchor && snap && Math.hypot(snap.x-orthogonalPoint(snap,anchor).x,snap.y-orthogonalPoint(snap,anchor).y)>1e-7) snap=null
    return {point:snap ?? constrained,snap}
  }
  function readShift(event: {shiftKey?:boolean}) { if (event.shiftKey!==undefined) shiftHeldRef.current=event.shiftKey }

  function previewSnap(event: React.PointerEvent<HTMLElement>) {
    readShift(event)
    if (!snapEnabled || panStartRef.current.active || !(lengthMode || runMode || areaMode || countMode || calibrationMode || readyToolKind)) { setSnapPreview(null); return }
    if (!drawingRef.current || !viewportRef.current) return
    const rect = drawingRef.current.getBoundingClientRect()
    const x=event.clientX-rect.left, y=event.clientY-rect.top
    if (x<0 || y<0 || x>rect.width || y>rect.height) { setSnapPreview(null); return }
    const [pdfX,pdfY]=viewportRef.current.convertToPdfPoint(x,y)
    setSnapPreview(resolvedPlacementPoint({ x:pdfX, y:pdfY }).snap)
  }
  useEffect(() => { setSnapPreview(null) }, [pdf, pageNumber, scale, rotation, snapEnabled, snapSource, snapEndpoints, snapMidpoints, lengthMode, runMode, areaMode, countMode, calibrationMode])

  function drawingPageName(number: number) { return drawingPages[number - 1]?.name || 'Page ' + number }

  function clampToolbox(position: Point): Point {
    const bounds=workspaceRef.current?.getBoundingClientRect()
    const box=toolboxRef.current?.getBoundingClientRect()
    if (!bounds || !box) return position
    return { x: Math.max(8, Math.min(position.x, bounds.width-box.width-8)), y: Math.max(0, Math.min(position.y, bounds.height-Math.min(box.height, bounds.height-16)-8)) }
  }
  useEffect(() => {
    if (sidebarTab !== 'measure' || toolboxDocked || !workspaceRef.current) return
    const resize=() => setToolboxPosition((position) => { const next=clampToolbox(position); return next.x === position.x && next.y === position.y ? position : next })
    resize()
    const observer=new ResizeObserver(resize)
    observer.observe(workspaceRef.current)
    if (toolboxRef.current) observer.observe(toolboxRef.current)
    return () => observer.disconnect()
  }, [toolboxOpen,sidebarTab,toolboxDocked])
  useEffect(()=>{
    if(sidebarTab!=='measure' || !workspaceRef.current) return
    const update=()=>{const header=toolbarHeaderRef.current?.getBoundingClientRect();if(header?.height)setToolbarBarHeight(current=>Math.abs(current-header.height)<0.5 ? current : header.height);const rect=workspaceRef.current?.getBoundingClientRect();if(rect)setToolbarOrigin(current=>current.x===(rect.left ?? 0) && current.y===(rect.top ?? 0) ? current : {x:rect.left ?? 0,y:rect.top ?? 0})}
    update();const observer=new ResizeObserver(update);observer.observe(workspaceRef.current);if(toolbarHeaderRef.current)observer.observe(toolbarHeaderRef.current)
    window.addEventListener('resize',update)
    return ()=>{observer.disconnect();window.removeEventListener('resize',update)}
  },[sidebarTab])
  useEffect(()=>{
    if(sidebarTab!=='measure' || !toolboxRef.current) return
    const update=()=>{const rect=toolboxRef.current?.getBoundingClientRect();if(rect?.width && rect.height)setPanelSize(current=>current.width===rect.width && current.height===rect.height ? current : {width:rect.width,height:rect.height})}
    update();const observer=new ResizeObserver(update);observer.observe(toolboxRef.current)
    return ()=>observer.disconnect()
  },[sidebarTab])
  function dockMeasurementPanel() {
    setBoardSizeReordering(false);setBoardPickerOpen(false);setToolboxDocked(true);setPanelMenu(null);setDescriptionOpen(false);setHoverHeading(null);setReorderDescriptions(false);setMessagesHidden(true);setSnapEnabled(false);toolboxDragRef.current=null
    const workspace=workspaceRef.current?.getBoundingClientRect(),box=toolboxRef.current?.getBoundingClientRect()
    setToolboxPosition({x:Math.max(0,((workspace?.width ?? window.innerWidth ?? 1200)-(box?.width ?? 342))/2),y:0})
  }
  function openPanelMenu(event: React.MouseEvent<HTMLDivElement>) {
    if((event.target as Element).closest('input,textarea,[contenteditable="true"]')) return
    event.preventDefault();event.stopPropagation();setDescriptionOpen(false);setMeasurementMenu(null);setWorkMenu(null)
    setPanelMenu({x:Math.max(8,Math.min(event.clientX,(window.innerWidth || 1200)-180)),y:Math.max(8,Math.min(event.clientY,(window.innerHeight || 800)-96))})
  }
  useEffect(()=>{
    if(!panelMenu) return
    const close=()=>setPanelMenu(null)
    const outside=(event: PointerEvent)=>{if(!(event.target as Element | null)?.closest('[data-panel-menu]'))close()}
    const escape=(event: KeyboardEvent)=>{if(event.key==='Escape')close()}
    window.addEventListener('pointerdown',outside);window.addEventListener('resize',close);window.addEventListener('keydown',escape)
    return ()=>{window.removeEventListener('pointerdown',outside);window.removeEventListener('resize',close);window.removeEventListener('keydown',escape)}
  },[panelMenu])
  function startToolboxDrag(event: React.PointerEvent<HTMLDivElement>) {
    if(event.button!==0 || (event.target as Element).closest('button,summary,input,select,textarea,a,[contenteditable="true"],[data-no-drag]')) return
    const workspace=workspaceRef.current?.getBoundingClientRect(),box=toolboxRef.current?.getBoundingClientRect()
    const origin=toolboxDocked && workspace && box ? {x:box.left-workspace.left,y:box.top-workspace.top} : toolboxPosition
    if(workspace)setToolbarOrigin({x:workspace.left ?? 0,y:workspace.top ?? 0})
    setPanelMenu(null);setDescriptionOpen(false)
    toolboxDragRef.current={id:event.pointerId,x:event.clientX,y:event.clientY,origin,moved:false}
    event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault()
  }
  function moveToolboxDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag=toolboxDragRef.current
    if(!drag || drag.id!==event.pointerId) return
    if(!drag.moved && Math.hypot(event.clientX-drag.x,event.clientY-drag.y)<4) return
    drag.moved=true;setToolboxDocked(false)
    setToolboxPosition(clampToolbox({x:drag.origin.x+event.clientX-drag.x,y:drag.origin.y+event.clientY-drag.y}))
  }
  function endToolboxDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag=toolboxDragRef.current
    if(!drag || drag.id!==event.pointerId) return
    toolboxDragRef.current=null
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId)
  }
  function moveIconToolbarWithKeys(event: React.KeyboardEvent<HTMLDivElement>) {
    if(event.target!==event.currentTarget) return
    if(event.key==='Enter') {event.preventDefault();event.stopPropagation();dockMeasurementPanel();return}
    const delta: Record<string,Point>={ArrowLeft:{x:-20,y:0},ArrowRight:{x:20,y:0},ArrowUp:{x:0,y:-20},ArrowDown:{x:0,y:20}}
    if(delta[event.key]) {
      event.preventDefault();const workspace=workspaceRef.current?.getBoundingClientRect(),box=toolboxRef.current?.getBoundingClientRect()
      const origin=toolboxDocked && workspace && box ? {x:box.left-workspace.left,y:box.top-workspace.top} : toolboxPosition
      setToolboxDocked(false);setToolboxPosition(clampToolbox({x:origin.x+delta[event.key].x,y:origin.y+delta[event.key].y}))
    }
  }
  function positionDescriptionMenu(target: HTMLElement) {
    const rect=target.getBoundingClientRect(),width=window.innerWidth || 1200,height=window.innerHeight || 800
    const panel=toolboxRef.current?.getBoundingClientRect() ?? rect
    const menuWidth=Math.min(560,width-16),menuHeight=90,reserveHeight=300
    const above=panel.top-menuHeight,below=panel.top+panel.height
    setDescriptionPosition({x:Math.max(8,Math.min(panel.left+panel.width/2-menuWidth/2,width-menuWidth-8)),y:Math.max(8,above-reserveHeight>=8 ? above : below+menuHeight+reserveHeight<=height-8 ? below : panel.top>height-below ? above : Math.min(below,height-menuHeight-8))})
  }
  useEffect(()=>{
    if(!descriptionOpen || !descriptionMenuRef.current) return
    const update=()=>{if(descriptionSummaryRef.current)positionDescriptionMenu(descriptionSummaryRef.current)}
    update();const observer=new ResizeObserver(update);observer.observe(descriptionMenuRef.current)
    return ()=>observer.disconnect()
  },[descriptionOpen,customFieldOpen,categories.length])
  function descriptionOptions(heading: WorkHeading | 'Other') {
    if(heading==='Other') return categories.filter(category=>category.id!=='tack-treds' && !category.id.startsWith('point-') && category.mode!=='derived' && !category.heading && !descriptionSections.some(section=>section.options.some(([id])=>id===category.id)) && (!legacyCategoryIds.has(category.id) || category.mode==='count' || groups.some(group=>group.categoryId===category.id))).map(category=>({category,label:category.name}))
    const section=descriptionSections.find(section=>section.title===heading)!
    return [...section.options.map(([id,label])=>({category:categories.find(category=>category.id===id)!,label})),...categories.filter(category=>!category.id.startsWith('point-') && category.heading===heading && !descriptionSections.some(section=>section.options.some(([id])=>id===category.id))).map(category=>({category,label:category.name}))].map((item,index)=>({...item,index})).sort((a,b)=>(a.category.menuOrder ?? a.index)-(b.category.menuOrder ?? b.index))
  }
  function moveDescription(heading: WorkHeading,id: string,delta: number) {
    const ids=descriptionOptions(heading).map(item=>item.category.id),index=ids.indexOf(id),target=index+delta
    if(index<0 || target<0 || target>=ids.length)return
    ;[ids[index],ids[target]]=[ids[target],ids[index]]
    setCategories(current=>current.map(category=>ids.includes(category.id) ? {...category,menuOrder:ids.indexOf(category.id)} : category))
  }
  useEffect(()=>{
    if(!descriptionOpen) setHoverHeading(null)
  },[descriptionOpen])
  useEffect(()=>{
    if(!descriptionOpen || !hoverHeading) return
    const update=()=>{const height=descriptionSubmenuRef.current?.getBoundingClientRect().height ?? 0,base=descriptionMenuRef.current?.getBoundingClientRect().height ?? 90,panelTop=toolboxRef.current?.getBoundingClientRect().top ?? 0;const above=descriptionPosition.y<panelTop;setSubmenuTop(above ? Math.max(-height+1,8-descriptionPosition.y) : Math.min(base-1,(window.innerHeight || 800)-descriptionPosition.y-height-8))}
    update();const observer=new ResizeObserver(update);if(descriptionSubmenuRef.current)observer.observe(descriptionSubmenuRef.current)
    return ()=>observer.disconnect()
  },[descriptionOpen,hoverHeading,descriptionPosition.y,categories.length])
  function descriptionMenuKeys(event: React.KeyboardEvent<HTMLDivElement>) {
    if((event.target as Element).closest('input')) return
    const isHeading=(event.target as Element).closest('[data-description-heading]')
    const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(isHeading ? '[data-description-heading]' : '[role="menuitemradio"]')),index=buttons.indexOf(event.target as HTMLButtonElement)
    if(isHeading && event.key==='ArrowDown') {event.preventDefault();descriptionSubmenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')?.focus();return}
    if(!isHeading && event.key==='ArrowLeft') {event.preventDefault();descriptionMenuRef.current?.querySelector<HTMLButtonElement>('[data-description-heading="'+hoverHeading+'"]')?.focus();return}
    if(['ArrowDown','ArrowRight','ArrowUp','ArrowLeft','Home','End'].includes(event.key)) {
      event.preventDefault();const next=event.key==='Home' ? 0 : event.key==='End' ? buttons.length-1 : index<0 ? 0 : (index+(event.key==='ArrowUp'||event.key==='ArrowLeft' ? -1 : 1)+buttons.length)%buttons.length
      buttons[next]?.focus()
    }
    if(event.key==='Escape') {event.preventDefault();event.stopPropagation();setDescriptionOpen(false);descriptionSummaryRef.current?.focus()}
  }
  useEffect(()=>{
    if(!descriptionOpen) return
    const outside=(event: PointerEvent)=>{if(!(event.target as Element | null)?.closest('.toolbar-description'))setDescriptionOpen(false)}
    const close=()=>setDescriptionOpen(false)
    const escape=(event: KeyboardEvent)=>{if(event.key==='Escape')close()}
    window.addEventListener('pointerdown',outside);window.addEventListener('resize',close);window.addEventListener('keydown',escape)
    return ()=>{window.removeEventListener('pointerdown',outside);window.removeEventListener('resize',close);window.removeEventListener('keydown',escape)}
  },[descriptionOpen])

  function updateCalibrationPoint(which: 'A' | 'B', point: Point) {
    if (pendingCalibration) {
      setPendingCalibration((current) => {
        if (!current) return current
        return which === 'A'
          ? { ...current, pointA: point }
          : { ...current, pointB: point }
      })

      setCalibrationPoints((current) => {
        if (current.length < 2) return current
        return which === 'A'
          ? [point, current[1]]
          : [current[0], point]
      })
      return
    }

    const saved = calibrations[pageNumber]

    if (saved) {
      if (saved.locked) return

      setCalibrations((current) => {
        const existing = current[pageNumber]
        if (!existing || existing.locked) return current

        const pointA = which === 'A' ? point : existing.pointA
        const pointB = which === 'B' ? point : existing.pointB

        return {
          ...current,
          [pageNumber]: {
            ...existing,
            pointA,
            pointB,
            needsRecalibration: true,
          },
        }
      })

      setRecalibrationDistance('')
      setStatus(
        'Calibration points changed — enter the new known distance and recalibrate before taking measurements.'
      )
      return
    }

    if (calibrationPoints.length === 1 && which === 'A') {
      setCalibrationPoints([point])
    }
  }

  function startCalibrationHandleDrag(
    event: React.PointerEvent<SVGCircleElement>,
    which: 'A' | 'B'
  ) {
    event.stopPropagation()
    event.preventDefault()

    const saved = calibrations[pageNumber]
    if (saved?.locked && !pendingCalibration) {
      setStatus('Calibration is locked. Unlock it before moving the points.')
      return
    }

    calibrationDragRef.current = {
      point: which,
      pointerId: event.pointerId,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveCalibrationHandle(
    event: React.PointerEvent<SVGCircleElement>
  ) {
    readShift(event)
    const drag = calibrationDragRef.current
    if (!drag.point || drag.pointerId !== event.pointerId) return

    event.stopPropagation()
    event.preventDefault()

    const point = clientToPdfPoint(event.clientX, event.clientY)
    if (point) updateCalibrationPoint(drag.point, point)
  }

  function endCalibrationHandleDrag(
    event: React.PointerEvent<SVGCircleElement>
  ) {
    const drag = calibrationDragRef.current
    if (!drag.point || drag.pointerId !== event.pointerId) return

    event.stopPropagation()
    event.preventDefault()

    calibrationDragRef.current = {
      point: null,
      pointerId: -1,
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function handleWheelZoom(event: React.WheelEvent<HTMLElement>) {
    if (!pdf || !stageRef.current || !drawingRef.current) return

    event.preventDefault()

    const currentScale = scale
    const zoomFactor = event.deltaY < 0 ? 1.15 : 1 / 1.15
    const nextScale = Math.max(
      0.25,
      Math.min(15, currentScale * zoomFactor)
    )

    if (Math.abs(nextScale - currentScale) < 0.0001) return

    const stageRect = stageRef.current.getBoundingClientRect()
    const drawingRect = drawingRef.current.getBoundingClientRect()

    const cursorX = event.clientX - stageRect.left
    const cursorY = event.clientY - stageRect.top

    const drawingLeft = drawingRect.left - stageRect.left
    const drawingTop = drawingRect.top - stageRect.top

    const localX =
      drawingRect.width > 0
        ? (cursorX - drawingLeft) / drawingRect.width
        : 0.5

    const localY =
      drawingRect.height > 0
        ? (cursorY - drawingTop) / drawingRect.height
        : 0.5

    const scaleRatio = nextScale / currentScale
    const nextWidth = viewportSize.width * scaleRatio
    const nextHeight = viewportSize.height * scaleRatio

    const desiredLeft = cursorX - localX * nextWidth
    const desiredTop = cursorY - localY * nextHeight

    const centredLeft = stageRect.width / 2 - nextWidth / 2
    const centredTop = stageRect.height / 2 - nextHeight / 2

    setPan({
      x: desiredLeft - centredLeft,
      y: desiredTop - centredTop,
    })

    setViewMode('manual')
    setScale(nextScale)
  }

  function hasValidCalibration() {
    const calibration = calibrations[pageNumber]
    return !!calibration && calibration.locked && !calibration.needsRecalibration
  }

  function revealActiveGroup() {
    setReadyToolKind(null)
    setOverviewDrawing(false)
    setSidebarTab('measure')
    setSelectedWorkId(null)
    setViewGroupId('')
    setViewCategoryId(activeGroup?.categoryId ?? '')
    if (activeGroupId) setHiddenGroupIds((current) => current.filter((id) => id !== activeGroupId))
    else setShowUngrouped(true)
  }

  function categoryColor(groupId: string | undefined, fallback: string) {
    const viewCategory = categories.find((category) => category.id === viewCategoryId)
    if (viewCategory?.mode === 'derived') return viewCategory.color
    const group = groups.find((item) => item.id === groupId)
    return group?.appearance?.color ?? categories.find((category) => category.id === group?.categoryId)?.color ?? fallback
  }

  function measurementAppearance(groupId?: string) {
    const appearance = groups.find((group) => group.id === groupId)?.appearance
    return { opacity: appearance?.opacity ?? 1, width: appearance?.width ?? 6 }
  }
  function updateWorkAppearance(id: string, change: NonNullable<MeasurementGroup['appearance']>) {
    setGroups((current) => current.map((group) => group.id === id ? { ...group, appearance: { ...group.appearance, ...change } } : group))
  }

  function countCategoryId(item: CountMeasurement) {
    return item.categoryId ?? groups.find((group) => group.id === item.groupId)?.categoryId ?? 'svp-boxing'
  }

  function currentToolKind(): MeasurementKind | null {
    return lengthMode ? 'length' : runMode ? 'run' : areaMode ? 'area' : countMode ? 'point' : readyToolKind
  }

  function toolDestination(kind: MeasurementKind, categoryId: string, customName = toolCustomName, availableCategories = categories) {
    const mode = kind === 'point' ? 'count' : 'measure'
    const name = customName.trim()
    let category = name ? availableCategories.find((item) => item.mode === mode && item.name.trim().toLowerCase() === name.toLowerCase())
      : availableCategories.find((item) => item.id === categoryId && item.mode === mode)
    if (!category && name) {
      let number = 1
      while (availableCategories.some((item) => item.id === 'custom-' + number)) number++
      category = { id: 'custom-' + number, name, color: availableCategories.find((item) => item.id === categoryId)?.color ?? '#0891b2', mode }
      const newCategory = category
      setCategories((current) => [...current, newCategory])
    }
    category ??= availableCategories.find((item) => item.mode === mode)
    if (!category) return null
    const targetCategory = category
    let group = groups.find((item) => item.categoryId === targetCategory.id && (!name || item.name.trim().toLowerCase() === name.toLowerCase()))
    if (!group) {
      const id = 'G' + String(nextGroupNumberRef.current++).padStart(3, '0')
      group = { id, name: name || category.name, categoryId: category.id }
      const newGroup = group
      setGroups((current) => [...current, newGroup])
    }
    setChooserCategoryId(category.id)
    setChooserGroupId(group.id)
    setActiveGroupId(group.id)
    setViewGroupId('')
    setViewCategoryId(category.id)
    setHiddenGroupIds((current) => current.filter((id) => id !== group.id))
    setSelectedWorkId(null)
    return group.id
  }

  function finishToolBeforeSwitch() {
    if (runMode) {
      if (runPoints.length >= 2 && toolHeightInvalid) { setStatus('Correct or clear the wall height before changing tools.'); return false }
      if (runPoints.length >= 2) { finishRun(); setToolSwitchNotice('Previous run saved and locked.') }
      else { cancelRun(); setToolSwitchNotice(runPoints.length ? 'Unfinished run point cleared.' : '') }
    } else if (areaMode) {
      if (!polygonProblem(areaPoints)) { finishArea(); setToolSwitchNotice('Previous area saved and locked.') }
      else { cancelArea(); setToolSwitchNotice(areaPoints.length ? 'Unfinished area points cleared.' : '') }
    } else if (lengthMode) {
      cancelLengthMeasurement(); setToolSwitchNotice(lengthPoints.length ? 'Unfinished length point cleared.' : '')
    } else if (countMode) { finishCounting(); setToolSwitchNotice('Placed point markers kept and locked.') }
    else setToolSwitchNotice('')
    setReadyToolKind(null)
    return true
  }

  function stopMeasurement() {
    setPointOptionsOpen(false)
    setSelectedEditPoint(null)
    if (runMode) {
      if (runPoints.length >= 2 && hasValidCalibration()) finishRun({ allowHeightDraft: true })
      else cancelRun()
    } else if (areaMode) {
      if (!polygonProblem(areaPoints) && hasValidCalibration()) finishArea()
      else cancelArea()
    } else if (lengthMode) cancelLengthMeasurement()
    else if (countMode) finishCounting()
    setRunMode(false); setRunPoints([])
    setAreaMode(false); setAreaPoints([])
    setLengthMode(false); setLengthPoints([])
    setCountMode(false); setReadyToolKind(null); setQueuedStart(null)
    setSnapPreview(null)
    panStartRef.current.active = false
    setIsPanning(false)
    setToolSwitchNotice('Measurement stopped. Finished measurements and point markers are kept; incomplete points are cleared.')
    if (currentToolKind()) setStatus('Measuring stopped. Valid runs and areas were saved; incomplete points were cleared. Finished measurements and point markers are kept.')
  }

  function navigateWorkspace(tab: typeof sidebarTab) {
    toolboxDragRef.current=null;setPanelMenu(null)
    setIsolatedMeasurementId(null);setDescriptionOpen(false);setBoardPickerOpen(false)
    if (tab==='measure') setToolboxOpen(true)
    stopMeasurement()
    setSidebarTab(tab)
    if (tab === 'groups' || tab === 'summary') {
      setViewGroupId(''); setViewCategoryId(''); setHiddenGroupIds([]); setShowUngrouped(true); setOverviewDrawing(true)
    }
    setSelectedWorkId(tab === 'groups' ? '__all__' : null)
    setWorkMenu(null); setMeasurementMenu(null)
  }

  function closeMeasureToolbox() { stopMeasurement(); setToolboxOpen(false) }

  function startToolMeasurement(kind: MeasurementKind) {
    setSelectedEditPoint(null)
    if (!pdf || queuedStart || !hasValidCalibration() || calibrationMode || pendingCalibration || toolHeightInvalid) return
    if (currentToolKind() === kind && !toolDoorHead) return
    if (!finishToolBeforeSwitch()) return
    setToolDoorHead(false)
    if (!toolDestination(kind, chooserCategoryId || activeCategory?.id || '')) return
    if (kind !== 'point') lastMeasureToolRef.current = kind
    setRunHeightM(toolWallHeight === '' ? undefined : Number(toolWallHeight))
    setQueuedStart(kind)
    setToolboxOpen(true)
  }

  function activateDoorHead() {
    setPointOptionsOpen(false)
    if(!pdf || !hasValidCalibration() || calibrationMode || pendingCalibration){setToolCalibrationNotice(measurementToolHelp());return}
    const category=categories.find(item=>item.id===(chooserCategoryId || activeCategory?.id || 'tack-timber-wall'))
    if(category?.mode!=='measure'){setStatus('Choose a wall work description before measuring a door head.');return}
    if(!finishToolBeforeSwitch())return
    if(!toolDestination('length',category.id,''))return
    setToolDoorHead(true);setRunHeightM(Number(toolWallHeight)>0 ? Number(toolWallHeight) : undefined);setQueuedStart('length');setToolboxOpen(true)
    setStatus('Door head: click the two sides of the doorway once. Opening height is 2000mm; both faces are included.')
  }

  function changeToolCategory(categoryId: string) {
    setPointOptionsOpen(false)
    setToolDoorHead(false)
    const category = categories.find((item) => item.id === categoryId && item.mode !== 'derived')
    if (!category) return
    const kind=currentToolKind(),nextKind: MeasurementKind=category.mode==='count' ? 'point' : /ceiling/i.test(category.name) ? 'area' : 'run'
    if(kind && kind!==nextKind && !finishToolBeforeSwitch())return
    if(!pdf || !hasValidCalibration() || calibrationMode || pendingCalibration) {chooseMeasurementCategory(categoryId);if(nextKind!=='point')lastMeasureToolRef.current=nextKind;return}
    toolDestination(nextKind,categoryId,'')
    if(kind!==nextKind)setQueuedStart(nextKind)
    if(nextKind!=='point')lastMeasureToolRef.current=nextKind
    setToolCustomName('')
  }

  function openNewDescription() {
    setNewDescriptionName('');setNewDescriptionError('');setNewDescriptionSkim('none')
    setNewDescriptionMode(currentToolKind()==='point' ? 'count' : 'measure')
    const selected=categories.find(category=>category.id===(chooserCategoryId || activeCategory?.id)),section=descriptionSections.find(section=>section.options.some(([id])=>id===selected?.id))
    setNewDescriptionHeading(selected?.heading ?? (section?.title as WorkHeading | undefined) ?? 'Tack')
    setDescriptionOpen(false);setPanelMenu(null);setNewDescriptionOpen(true)
  }
  function saveNewDescription() {
    const name=newDescriptionName.trim()
    if(!name) {setNewDescriptionError('Enter a work description name.');return}
    if(name.length>100) {setNewDescriptionError('Use a name of 100 characters or fewer.');return}
    const duplicate=categories.some(category=>(category.name.trim().toLowerCase()===name.toLowerCase() || descriptionSections.find(section=>section.title===newDescriptionHeading)?.options.some(([id,label])=>id===category.id && label.toLowerCase()===name.toLowerCase())) && (category.heading ?? descriptionSections.find(section=>section.options.some(([id])=>id===category.id))?.title)===newDescriptionHeading)
    if(duplicate) {setNewDescriptionError('That work description already exists under '+newDescriptionHeading+'. Choose it from the menu or use a different name.');return}
    const kind=currentToolKind(),switchType=!!kind && ((kind==='point')!==(newDescriptionMode==='count'))
    if(switchType && !finishToolBeforeSwitch()) {setNewDescriptionError('Correct or clear the current wall height before changing the measurement type.');return}
    let number=1;while(categories.some(category=>category.id==='custom-'+number))number++
    const first=descriptionSections.find(section=>section.title===newDescriptionHeading)?.options[0]?.[0]
    const category: WorkCategory={id:'custom-'+number,name,heading:newDescriptionHeading,mode:newDescriptionMode,color:categories.find(category=>category.id===first)?.color ?? '#0891b2',...(newDescriptionMode==='measure' && newDescriptionSkim!=='none' ? {skimTarget:newDescriptionSkim} : {})}
    setCategories(current=>[...current,category]);setSubcontractorRates(current=>({...current,...defaultSubcontractorRates([category])}));setToolCustomName('')
    if(kind) {
      const targetKind=switchType ? newDescriptionMode==='count' ? 'point' : lastMeasureToolRef.current : kind
      toolDestination(targetKind,category.id,'',[...categories,category]);if(switchType)setQueuedStart(targetKind)
    } else {setChooserCategoryId(category.id);setChooserGroupId('__new__')}
    setNewDescriptionOpen(false);setDescriptionOpen(false);setHoverHeading(null)
    setStatus(name+' created under '+newDescriptionHeading+'. It is selected and ready to measure.')
    setToolSwitchNotice(name+' created and selected. Automatic skim: '+(category.skimTarget ? category.skimTarget : 'not included')+'.')
  }
  function applyToolCustomName() {
    const kind = currentToolKind()
    if (kind) {
      toolDestination(kind, chooserCategoryId || activeCategory?.id || '')
      setToolSwitchNotice(kind === 'point' ? 'New point markers will use this name. Existing markers are unchanged.' : 'Current points kept; this measurement will use the selected name.')
    }
  }

  function requestMeasurement(kind: MeasurementKind) {
    if (!pdf || hasDraft || queuedStart || (kind !== 'point' && !hasValidCalibration())) return
    const mode = kind === 'point' ? 'count' : 'measure'
    const category = categories.find((item) => item.id === chooserCategoryId && item.mode === mode)
      ?? categories.find((item) => item.id === activeGroup?.categoryId && item.mode === mode)
      ?? categories.find((item) => item.mode === mode)
    if (!category) return
    setMeasurementChooser(kind)
    chooseMeasurementCategory(category.id)
    setChooserGroupName('')
  }

  function chooseMeasurementCategory(categoryId: string) {
    setChooserCategoryId(categoryId)
    const group = groups.find((item) => item.id === activeGroupId && item.categoryId === categoryId)
      ?? groups.find((item) => item.categoryId === categoryId)
    setChooserGroupId(group?.id ?? '__new__')
  }

  function confirmMeasurement() {
    if (measurementChooser === 'run') {
      setStartingWallHeight(toolWallHeight)
      setHeightPromptOpen(true)
      return
    }
    commitMeasurementStart()
  }

  function confirmRunHeight(skip = false) {
    if (!heightPromptOpen || (measurementChooser !== 'run' && measurementChooser !== 'length')) return
    const value = startingWallHeight.trim()
    if (!skip && value !== '' && (!Number.isFinite(Number(value)) || Number(value) <= 0)) return
    setToolWallHeight(skip ? '' : value)
    setRunHeightM(skip || value === '' ? undefined : Number(value))
    setHeightPromptOpen(false)
    commitMeasurementStart()
  }

  function commitMeasurementStart() {
    if (!measurementChooser || hasDraft) return
    const category = categories.find((item) => item.id === chooserCategoryId)
    if (!category || category.mode !== (measurementChooser === 'point' ? 'count' : 'measure')) return
    let groupId = chooserGroupId
    if (groupId === '__new__') {
      groupId = `G${String(nextGroupNumberRef.current++).padStart(3, '0')}`
      const id = groupId
      setGroups((current) => [...current, { id, name: chooserGroupName.trim() || category.name || category.id, categoryId: category.id }])
    } else if (!groups.some((group) => group.id === groupId && group.categoryId === category.id)) return
    setActiveGroupId(groupId)
    setHiddenGroupIds((current) => current.filter((id) => id !== groupId))
    setSidebarTab('measure')
    setQueuedStart(measurementChooser)
    setMeasurementChooser(null)
  }

  function beginQueuedMeasurement() {
    const kind = queuedStart
    setQueuedStart(null)
    setReadyToolKind(null)
    if (kind === 'length') startLengthMeasurement()
    else if (kind === 'run') startRun(runHeightM)
    else if (kind === 'area') startArea()
    else if (kind === 'point') startCounting()
  }

  function selectViewCategory(categoryId: string) {
    setOverviewDrawing(false)
    if (categoryId && !categories.some((category) => category.id === categoryId)) return
    setViewCategoryId(categoryId)
    setViewGroupId('')
    setHiddenGroupIds([])
    setShowUngrouped(true)
  }

  function matchesViewCategory(groupId?: string, pointCategoryId?: string, isWall = false, heightM?: number) {
    if (viewGroupId) return groupId === viewGroupId
    if (!viewCategoryId) return true
    const category = categories.find((item) => item.id === viewCategoryId)
    const group = groups.find((item) => item.id === groupId)
    if (category?.mode === 'derived') {
      const sourceCategory = categories.find((item) => item.id === group?.categoryId)
      return !pointCategoryId && group?.includeSkim !== false && sourceCategory?.skimTarget === (category.id === 'skimmed-walls' ? 'walls' : 'ceilings')
        && (!isWall || heightM !== undefined)
    }
    return (pointCategoryId ?? group?.categoryId) === viewCategoryId
  }

  function isMeasurementVisible(groupId?: string, pointCategoryId?: string, isWall = false, heightM?: number) {
    if (viewGroupId) return groupId === viewGroupId
    if (viewCategoryId) return matchesViewCategory(groupId, pointCategoryId, isWall, heightM)
    return groupId ? !hiddenGroupIds.includes(groupId) : showUngrouped
  }

  function setGroupCategory(id: string, categoryId: string) {
    if (hasDraft) return
    const category = categories.find((item) => item.id === categoryId)
    if (categoryId && (!category || category.mode === 'derived')) return
    const geometry = [...Object.values(lengthMeasurements).flat(), ...Object.values(runMeasurements).flat(), ...Object.values(areaMeasurements).flat()]
    const counts = Object.values(countMeasurements).flat()
    if (category?.mode === 'count' && geometry.some((item) => item.groupId === id)) {
      setStatus('SVP Boxing uses crosses only. Move this group’s lengths or areas to another group first.')
      return
    }
    if (category?.mode !== 'count' && counts.some((item) => item.groupId === id)) {
      setStatus('This group contains point marks. Move them to another point group first.')
      return
    }
    setGroups((current) => current.map((group) => group.id === id ? { ...group, categoryId: categoryId || undefined } : group))
    if (category?.mode === 'count') setCountMeasurements((current) => Object.fromEntries(Object.entries(current).map(([page, items]) =>
      [page, items.map((item) => item.groupId === id ? { ...item, categoryId } : item)])))
  }

  function updateCategory(id: string, details: { name?: string; color?: string }) {
    if (details.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(details.color)) return
    setCategories((current) => current.map((category) => category.id === id ? { ...category, ...details } : category))
  }

  function createCategory() {
    const name = newCategoryName.trim()
    if (!name || !/^#[0-9a-fA-F]{6}$/.test(newCategoryColor)) return
    let number = 1
    while (categories.some((category) => category.id === `custom-${number}`)) number++
    setCategories((current) => [...current, { id: `custom-${number}`, name, color: newCategoryColor, mode: newCategoryMode }])
    setNewCategoryName('')
  }

  function startCounting() {
    countSessionIdsRef.current=[]
    if (!pdf || hasDraft) return
    setReadyToolKind(null)
    let groupId = activeCategory?.mode === 'count' ? activeGroup!.id
      : groups.find((group) => group.categoryId === 'svp-boxing')?.id
    if (!groupId) {
      groupId = `G${String(nextGroupNumberRef.current++).padStart(3, '0')}`
      const id = groupId
      setGroups((current) => [...current, { id, name: 'SVP Boxing', categoryId: 'svp-boxing' }])
    }
    setActiveGroupId(groupId)
    setViewCategoryId(groups.find((group) => group.id === groupId)?.categoryId ?? 'svp-boxing')
    setHiddenGroupIds((current) => current.filter((id) => id !== groupId))
    setSidebarTab('measure')
    setSelectedWorkId(null)
    setViewGroupId('')
    setCountMode(true)
    setStatus('Points: click once at each location to add a cross. Press Enter or Done Marking when finished.')
  }

  function addCountPoint(clientX: number, clientY: number) {
    if ((!countMode && readyToolKind !== 'point') || !pdf || activeCategory?.mode !== 'count') return
    const point = clientToPdfPoint(clientX, clientY)
    if (!point) return
    if (readyToolKind === 'point') { countSessionIdsRef.current=[]; setCountMode(true); setReadyToolKind(null); revealActiveGroup() }
    if ((countMeasurements[pageNumber] ?? []).some((item) => countCategoryId(item) === activeCategory.id && Math.hypot(item.point.x - point.x, item.point.y - point.y) < 0.000001)) return
    const id = `C${String(nextCountNumberRef.current++).padStart(3, '0')}`
    countSessionIdsRef.current.push(id)
    setCountMeasurements((current) => ({ ...current,
      [pageNumber]: [...(current[pageNumber] ?? []), { id, point, locked: true, ...boardSnapshot(), groupId: activeGroupId, categoryId: activeCategory.id }],
    }))
  }

  function finishCounting() {
    setCountMode(false)
    setReadyToolKind('point')
    setStatus('Ready for more points. Point marks are kept and locked. They can now be saved with the take-off.')
  }

  function toggleCountLock(id: string) {
    setCountMeasurements((current) => ({ ...current,
      [pageNumber]: (current[pageNumber] ?? []).map((item) => item.id === id ? { ...item, locked: !item.locked } : item),
    }))
  }

  function deleteCount(id: string) {
    setCountMeasurements((current) => ({ ...current, [pageNumber]: (current[pageNumber] ?? []).filter((item) => item.id !== id) }))
  }

  function startCountHandleDrag(event: React.PointerEvent<SVGCircleElement>, countId: string) {
    if (event.button !== 0 || hasDraft) return
    const count = (countMeasurements[pageNumber] ?? []).find((item) => item.id === countId)
    if (!count || count.locked) return
    event.preventDefault()
    event.stopPropagation()
    setSelectedEditPoint({id:countId,kind:'point',index:0,page:pageNumber})
    stageRef.current?.focus({preventScroll:true})
    countDragRef.current = { countId, pointerId: event.pointerId }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveCountHandle(event: React.PointerEvent<SVGCircleElement>) {
    readShift(event)
    const drag = countDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    const point = clientToPdfPoint(event.clientX, event.clientY)
    if (!point) return
    setCountMeasurements((current) => ({ ...current,
      [pageNumber]: (current[pageNumber] ?? []).map((item) => item.id === drag.countId && !item.locked ? { ...item, point } : item),
    }))
  }

  function endCountHandleDrag(event: React.PointerEvent<SVGCircleElement>) {
    if (countDragRef.current?.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    countDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function startArea() {
    if (!hasValidCalibration() || runMode || areaMode || countMode || activeIsCount) return
    revealActiveGroup()
    setLengthMode(false)
    setLengthPoints([])
    setCalibrationMode(false)
    setCalibrationPoints([])
    setPendingCalibration(null)
    setAreaMode(true)
    setAreaPoints([])
    setStatus('Area: click around the outside of the shape, then press Finish Area to close the outline. Drag to pan; use the wheel to zoom.')
  }

  function addAreaPoint(clientX: number, clientY: number) {
    if ((!areaMode && readyToolKind !== 'area') || !hasValidCalibration()) return
    const point = clientToPdfPoint(clientX, clientY)
    if (!point) return
    if (readyToolKind === 'area') { setAreaMode(true); setReadyToolKind(null); revealActiveGroup() }
    if (areaPoints.some((existing) => Math.hypot(existing.x - point.x, existing.y - point.y) < 0.000001)) {
      setStatus('That corner is already placed. Use Finish Area to close the shape, or click a new corner.')
      return
    }
    setAreaPoints((current) => [...current, point])
  }

  function finishArea() {
    if (!areaMode || !hasValidCalibration()) return
    const problem = polygonProblem(areaPoints)
    if (problem) { setStatus(problem); return }
    const id = `A${String(nextAreaNumberRef.current++).padStart(3, '0')}`
    setAreaMeasurements((current) => ({
      ...current,
      [pageNumber]: [...(current[pageNumber] ?? []), {
        id, points: [...areaPoints], locked: true, ...boardSnapshot(), ...(activeGroupId ? { groupId: activeGroupId } : {}),
      }],
    }))
    setAreaMode(false)
    setAreaPoints([])
    setReadyToolKind('area')
    setStatus(`${id} finished and locked. Click the next start point to measure another area. Untick Lock to adjust its corners.`)
  }

  function cancelArea() {
    setReadyToolKind(null)
    setAreaMode(false)
    setAreaPoints([])
    setStatus('Unfinished area cancelled. Saved measurements have been kept.')
  }

  function toggleAreaLock(id: string) {
    setAreaMeasurements((current) => ({
      ...current,
      [pageNumber]: (current[pageNumber] ?? []).map((item) => item.id === id ? { ...item, locked: !item.locked } : item),
    }))
  }

  function deleteArea(id: string) {
    setAreaMeasurements((current) => ({
      ...current, [pageNumber]: (current[pageNumber] ?? []).filter((item) => item.id !== id),
    }))
    setStatus(`${id} deleted.`)
  }

  function startAreaHandleDrag(event: React.PointerEvent<SVGCircleElement>, areaId: string, pointIndex: number) {
    if (event.button !== 0 || hasDraft || !hasValidCalibration()) return
    const area = (areaMeasurements[pageNumber] ?? []).find((item) => item.id === areaId)
    if (!area || area.locked) return
    event.stopPropagation()
    event.preventDefault()
    setSelectedEditPoint({id:areaId,kind:'area',index:pointIndex,page:pageNumber})
    stageRef.current?.focus({preventScroll:true})
    areaDragRef.current = { areaId, pointIndex, pointerId: event.pointerId }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveAreaHandle(event: React.PointerEvent<SVGCircleElement>) {
    readShift(event)
    const drag = areaDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.stopPropagation()
    event.preventDefault()
    if (!hasValidCalibration()) return
    const point = clientToPdfPoint(event.clientX, event.clientY)
    const area = (areaMeasurements[pageNumber] ?? []).find((item) => item.id === drag.areaId)
    if (!point || !area || area.locked) return
    const points = area.points.map((p, i) => i === drag.pointIndex ? point : p)
    const problem = polygonProblem(points)
    if (problem) { setStatus(`Corner unchanged: ${problem}`); return }
    setAreaMeasurements((current) => ({
      ...current,
      [pageNumber]: (current[pageNumber] ?? []).map((item) => item.id === drag.areaId ? { ...item, points } : item),
    }))
  }

  function endAreaHandleDrag(event: React.PointerEvent<SVGCircleElement>) {
    if (areaDragRef.current?.pointerId !== event.pointerId) return
    event.stopPropagation()
    event.preventDefault()
    areaDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function setWorkWallHeight(groupId: string, text: string, scopePage?: number) {
    setGroupHeightDrafts((current) => ({ ...current, [scopePage === undefined ? groupId : groupId + ':' + scopePage]: text }))
    if (text !== '' && (!Number.isFinite(Number(text)) || Number(text) <= 0)) return
    const heightM = text === '' ? undefined : Number(text)
    const change = <T extends { id: string; groupId?: string; heightM?: number },>(record: Record<number, T[]>) =>
      Object.fromEntries(Object.entries(record).map(([page, items]) => [page, items.map((item) => item.groupId === groupId && (scopePage === undefined || Number(page) === scopePage) ? { ...item, heightM } : item)]))
    const walls = [...Object.entries(lengthMeasurements).flatMap(([page, items]) => scopePage === undefined || Number(page) === scopePage ? items : []), ...Object.entries(runMeasurements).flatMap(([page, items]) => scopePage === undefined || Number(page) === scopePage ? items : [])].filter((item) => item.groupId === groupId)
    setLengthMeasurements(change)
    setRunMeasurements(change)
    setHeightDrafts((current) => ({ ...current, ...Object.fromEntries(walls.map((item) => [item.id, text])) }))
  }

  function setWallHeight(id: string, text: string, measurementPage = pageNumber) {
    const wall = [...(lengthMeasurements[measurementPage] ?? []), ...(runMeasurements[measurementPage] ?? [])].find((item) => item.id === id)
    if (wall?.groupId) setGroupHeightDrafts((current) => { const next = { ...current }; delete next[wall.groupId!]; delete next[wall.groupId! + ':' + measurementPage]; return next })
    setHeightDrafts((current) => ({ ...current, [id]: text }))
    if (text === '') updateMeasurementDetails(id, { heightM: undefined }, measurementPage)
    else if (Number.isFinite(Number(text)) && Number(text) > 0) updateMeasurementDetails(id, { heightM: Number(text) }, measurementPage)
  }

  function wallHeightField(id: string, heightM: number | undefined, lengthMm: number | null, measurementPage = pageNumber) {
    const text = heightDrafts[id] ?? (heightM === undefined ? '' : String(heightM))
    const doorHead=!!savedMeasurement(id,measurementPage)?.item && !!(savedMeasurement(id,measurementPage)?.item as LengthMeasurement).doorHead
    const invalid = text !== '' && (!Number.isFinite(Number(text)) || Number(text) <= 0)
    const headInvalid=doorHead && !(heightM!==undefined && heightM>2)
    return (
      <div className="wall-height-field">
        {doorHead && <p className="door-head-note">Door head · 2000mm opening · both faces. Width is measured once; no extra wall LM is added.</p>}
        {headInvalid && <p className="calibration-warning">Enter a wall height greater than 2000mm for this door head.</p>}
        <label>
          Wall height (mm, optional)
          <input type="number" min="0.001" step="any" inputMode="decimal" value={heightInMm(text)}
            placeholder="e.g. 2400" aria-label={`Wall height for ${id}`} aria-invalid={invalid}
            onChange={(event) => setWallHeight(id, heightFromMm(event.target.value), measurementPage)} />
        </label>
        {invalid ? <p className="calibration-warning">Enter a height greater than zero, or clear the field.</p>
          : heightM !== undefined ? <>
            <div className="wall-area-result">{lengthMm === null ? 'Calibration required' : wallAreaFromLength(lengthMm,heightM,doorHead)===null ? 'Check wall height' : `${wallAreaFromLength(lengthMm,heightM,doorHead)!.toFixed(2)} m²`}</div>
            <p className="length-note">{lengthMm === null ? '' : `${(lengthMm / 1000).toFixed(2)} m × ${heightInMm(String(heightM))} mm · `}{doorHead ? 'Width × (wall height − 2000mm) × 2 faces.' : 'One face, before deductions.'}</p>
          </> : <p className="length-note">Add height to calculate wall area. Leave blank for length only.</p>}
      </div>
    )
  }

  function startRun(heightM?: number) {
    if (!hasValidCalibration() || runMode || areaMode || countMode || activeIsCount) return
    revealActiveGroup()
    setLengthMode(false)
    setLengthPoints([])
    setCalibrationMode(false)
    setCalibrationPoints([])
    setPendingCalibration(null)
    setRunPoints([])
    setRunHeightM(heightM)
    setRunMode(true)
    setStatus('Run: click the start, then each wall corner. Pan or zoom as needed. Press Finish Run when done.')
  }

  function createGroup() {
    const name = newGroupName.trim()
    if (!pdf || !name || hasDraft) return
    const id = `G${String(nextGroupNumberRef.current++).padStart(3, '0')}`
    setGroups((current) => [...current, { id, name }])
    setActiveGroupId(id)
    setNewGroupName('')
    setStatus(`${name} created. New lengths and runs will be added to this group.`)
  }

  function renameGroup(id: string, name: string) {
    setGroups((current) => current.map((group) => group.id === id ? { ...group, name } : group))
  }

  function updateMeasurementDetails(id: string, details: { name?: string; groupId?: string; heightM?: number; boardSpec?: BoardSpec | null }, measurementPage = pageNumber) {
    if (details.groupId && !groups.some((group) => group.id === details.groupId)) return
    if (details.groupId) {
      const categoryId = groups.find((group) => group.id === details.groupId)?.categoryId
      if (id.startsWith('C') ? categories.find((category) => category.id === categoryId)?.mode !== 'count' : categories.find((category) => category.id === categoryId)?.mode === 'count') return
    }
    if (details.heightM !== undefined && (!Number.isFinite(details.heightM) || details.heightM <= 0 || id.startsWith('A'))) return
    // Names and membership can change while geometry stays locked.
    setLengthMeasurements((current) => ({
      ...current,
      [measurementPage]: (current[measurementPage] ?? []).map((item) => item.id === id ? { ...item, ...details } : item),
    }))
    setRunMeasurements((current) => ({
      ...current,
      [measurementPage]: (current[measurementPage] ?? []).map((item) => item.id === id ? { ...item, ...details } : item),
    }))
    if (!('heightM' in details)) setAreaMeasurements((current) => ({
      ...current,
      [measurementPage]: (current[measurementPage] ?? []).map((item) => item.id === id ? { ...item, ...details } : item),
    }))
    if (!('heightM' in details)) setCountMeasurements((current) => ({ ...current,
      [measurementPage]: (current[measurementPage] ?? []).map((item) => item.id === id ? { ...item, ...details,
        ...('groupId' in details ? { categoryId: details.groupId ? groups.find((group) => group.id === details.groupId)?.categoryId : countCategoryId(item) } : {}) } : item),
    }))
  }

  function removeGroup(id: string) {
    if (hasDraft) return
    setGroups((current) => current.filter((group) => group.id !== id))
    const ungroup = <T extends { groupId?: string },>(items: Record<number, T[]>) =>
      Object.fromEntries(Object.entries(items).map(([page, list]) => [page, list.map((item) => {
        if (item.groupId !== id) return item
        const { groupId: _groupId, ...rest } = item
        return rest as T
      })]))
    setLengthMeasurements((current) => ungroup(current))
    setRunMeasurements((current) => ungroup(current))
    setAreaMeasurements((current) => ungroup(current))
    setCountMeasurements((current) => ungroup(Object.fromEntries(Object.entries(current).map(([page, items]) =>
      [page, items.map((item) => ({ ...item, categoryId: countCategoryId(item) }))]))))
    setHiddenGroupIds((current) => current.filter((groupId) => groupId !== id))
    if (activeGroupId === id) setActiveGroupId('')
    if (selectedWorkId === id) setSelectedWorkId(null)
    if (viewGroupId === id) setViewGroupId('')
    setStatus('Group removed. Its measurements have been kept as ungrouped measurements.')
  }

  function savedMeasurement(id: string,number: number) {
    const length=(lengthMeasurements[number] ?? []).find(item=>item.id===id)
    if(length) return {kind:'length' as const,item:length}
    const run=(runMeasurements[number] ?? []).find(item=>item.id===id)
    if(run) return {kind:'run' as const,item:run}
    const area=(areaMeasurements[number] ?? []).find(item=>item.id===id)
    if(area) return {kind:'area' as const,item:area}
    const point=(countMeasurements[number] ?? []).find(item=>item.id===id)
    return point ? {kind:'point' as const,item:point} : null
  }
  function requestDuplicate(ids: string[],number=pageNumber) {
    if (hasDraft || !ids.length || duplicateBusyRef.current || fileBusyRef.current) return
    const members=ids.map(id=>savedMeasurement(id,number))
    if(members.some(item=>!item)) return
    const first=members[0]!, group=groups.find(group=>group.id===first.item.groupId)
    const categoryId=first.kind==='point' ? countCategoryId(first.item as CountMeasurement) : group?.categoryId ?? ''
    stopMeasurement();setSelectedEditPoint(null);setMeasurementMenu(null);setWorkMenu(null)
    setDuplicatePage(number);setDuplicateKeepDescription(true);setDuplicateCategoryId(categoryId);setDuplicateError('')
    setDuplicateRequest({ids:[...ids],page:number,title:ids.length===1 ? first.item.name || first.item.id : (group?.name || 'Measured work')+' ('+ids.length+' measurements)',categoryId})
  }
  async function confirmDuplicate() {
    if(!duplicateRequest || !pdf || duplicateBusyRef.current || fileBusyRef.current) return
    const request=duplicateRequest, destination=duplicatePage
    duplicateBusyRef.current=true;setDuplicating(true);setDuplicateError('')
    try {
      if(!drawingPages[destination-1]) throw Error('Choose a destination drawing.')
      const members=request.ids.map(id=>savedMeasurement(id,request.page))
      if(members.some(item=>!item)) throw Error('The original measurement is no longer available.')
      const hasGeometry=members.some(entry=>entry!.kind!=='point'), hasPoints=members.some(entry=>entry!.kind==='point')
      if(hasGeometry && hasPoints) throw Error('Copy lengths/areas separately from point markers.')
      const category=categories.find(item=>item.id===duplicateCategoryId)
      if(!duplicateKeepDescription && (!category || category.mode!==(hasGeometry ? 'measure' : 'count'))) throw Error('Choose a compatible work description.')
      const sourceCalibration=calibrations[request.page],targetCalibration=calibrations[destination]
      if(hasGeometry && (!sourceCalibration?.locked || sourceCalibration.needsRecalibration || !targetCalibration?.locked || targetCalibration.needsRecalibration)) throw Error('Calibrate and lock both the original and destination pages before copying. This keeps the quantity correct.')
      if(members.some(entry=>{const value=heightDrafts[entry!.item.id];return value!==undefined && value!=='' && (!Number.isFinite(Number(value)) || Number(value)<=0)})) throw Error('Correct the original wall height before duplicating.')
      const ratio=hasGeometry ? sourceCalibration.mmPerPdfUnit/targetCalibration.mmPerPdfUnit : 1
      const page=await pdf.getPage(destination),bounds=page.view
      if(!bounds || bounds.length!==4) throw Error('The destination page could not be read. Please try again.')
      const first=members[0]!,origin=first.kind==='length' ? first.item.pointA : first.kind==='point' ? first.item.point : first.item.points[0]
      const transformed=members.map(entry=>{
        const source=entry!,points=source.kind==='length' ? [source.item.pointA,source.item.pointB] : source.kind==='point' ? [source.item.point] : source.item.points
        return {source,points:points.map(point=>({x:origin.x+(point.x-origin.x)*ratio,y:origin.y+(point.y-origin.y)*ratio}))}
      })
      // Move the copied selection onto the page without changing its size or quantities.
      const points=transformed.flatMap(entry=>entry.points),minX=Math.min(...points.map(p=>p.x)),maxX=Math.max(...points.map(p=>p.x)),minY=Math.min(...points.map(p=>p.y)),maxY=Math.max(...points.map(p=>p.y))
      if(maxX-minX>bounds[2]-bounds[0]+0.000001 || maxY-minY>bounds[3]-bounds[1]+0.000001) throw Error('The copied measurement is too large for that page at its calibrated scale. Choose another page or check the calibration.')
      const dx=minX<bounds[0] ? bounds[0]-minX : maxX>bounds[2] ? bounds[2]-maxX : 0,dy=minY<bounds[1] ? bounds[1]-minY : maxY>bounds[3] ? bounds[3]-maxY : 0
      let destinationGroup=duplicateKeepDescription ? undefined : groups.find(group=>group.categoryId===category!.id)
      let newGroup: MeasurementGroup | undefined
      if(!duplicateKeepDescription && !destinationGroup) {
        newGroup={id:'G'+String(nextGroupNumberRef.current++).padStart(3,'0'),name:category!.name,categoryId:category!.id};destinationGroup=newGroup
      }
      const copied=transformed.map(({source,points})=>{
        const placed=points.map(point=>({x:point.x+dx,y:point.y+dy})), groupId=duplicateKeepDescription ? source.item.groupId : destinationGroup!.id
        const common={...source.item,groupId,locked:true}
        if(source.kind==='length') return {kind:'length' as const,item:{...common,id:'L'+String(nextLengthNumberRef.current++).padStart(3,'0'),pointA:placed[0],pointB:placed[1]} as LengthMeasurement}
        if(source.kind==='run') return {kind:'run' as const,item:{...common,id:'R'+String(nextRunNumberRef.current++).padStart(3,'0'),points:placed} as RunMeasurement}
        if(source.kind==='area') return {kind:'area' as const,item:{...common,id:'A'+String(nextAreaNumberRef.current++).padStart(3,'0'),points:placed} as AreaMeasurement}
        return {kind:'point' as const,item:{...common,id:'C'+String(nextCountNumberRef.current++).padStart(3,'0'),point:placed[0],categoryId:duplicateKeepDescription ? countCategoryId(source.item) : category!.id} as CountMeasurement}
      })
      if(newGroup) setGroups(current=>[...current,newGroup!])
      setLengthMeasurements(current=>({...current,[destination]:[...(current[destination] ?? []),...copied.filter(item=>item.kind==='length').map(item=>item.item)]}))
      setRunMeasurements(current=>({...current,[destination]:[...(current[destination] ?? []),...copied.filter(item=>item.kind==='run').map(item=>item.item)]}))
      setAreaMeasurements(current=>({...current,[destination]:[...(current[destination] ?? []),...copied.filter(item=>item.kind==='area').map(item=>item.item)]}))
      setCountMeasurements(current=>({...current,[destination]:[...(current[destination] ?? []),...copied.filter(item=>item.kind==='point').map(item=>item.item)]}))
      setDuplicateRequest(null);setPageNumber(destination);setSidebarTab('groups');setSelectedWorkId(copied[0].item.groupId ?? '__all__');setViewGroupId(copied[0].item.groupId ?? '');setViewCategoryId('');setHiddenGroupIds([]);setShowUngrouped(true);setOverviewDrawing(false);setIsolatedMeasurementId(copied.length===1 ? copied[0].item.id : null);setViewMode('fit-page');setPan({x:0,y:0})
      setStatus(copied.length+' measurement'+(copied.length===1 ? '' : 's')+' duplicated to '+drawingPageName(destination)+'. Copies are locked and can be edited independently.')
    } catch(error) {setDuplicateError(error instanceof Error ? error.message : 'Could not duplicate this measurement.')}
    finally {duplicateBusyRef.current=false;setDuplicating(false)}
  }

  function orderedBoardSizes(): Array<[number,number]> {return boardSizeOrder.map(id=>boardSizes.find(([w,l])=>w+'x'+l===id)!).filter(Boolean)}
  function moveBoardSize(id:string,delta:number) {setBoardSizeOrder(current=>{const index=current.indexOf(id),target=index+delta;if(index<0 || target<0 || target>=current.length)return current;const next=[...current];[next[index],next[target]]=[next[target],next[index]];return next})}
  function toolBoardSelection(): BoardChoice {return boardPreferences[chooserCategoryId || activeCategory?.id || 'tack-ceiling']}
  function boardSnapshot() {const spec=toolBoardSelection();return spec===undefined ? {} : {boardSpec:spec ? {...spec} : null}}
  function boardPickerHeight() {
    if(boardTarget && 'groupId' in boardTarget) {const target=boardTarget;const heights=[...(lengthMeasurements[target.page] ?? []),...(runMeasurements[target.page] ?? [])].filter(item=>item.groupId===target.groupId && item.heightM!==undefined).map(item=>item.heightM!);return heights.length ? Math.max(...heights) : undefined}
    if(boardTarget && 'id' in boardTarget) {const saved=savedMeasurement(boardTarget.id,boardTarget.page);return saved && (saved.kind==='length' || saved.kind==='run') ? saved.item.heightM : undefined}
    return currentToolKind()==='area' || currentToolKind()==='point' ? undefined : toolWallHeight!=='' && Number(toolWallHeight)>0 ? Number(toolWallHeight) : undefined
  }
  function openBoardPicker(target: BoardTarget | null,button: HTMLButtonElement) {
    boardTriggerRef.current=button;setBoardSizeReordering(false);setBoardTarget(target);setBoardStep('type');setBoardDraftOverride(undefined);setBoardPendingSize(null);setBoardPendingSpec(null);setDescriptionOpen(false)
    const rect=button.getBoundingClientRect(),width=window.innerWidth || 1200,height=window.innerHeight || 800
    setBoardPosition({x:Math.max(8,Math.min(rect.left+rect.width/2-Math.min(370,width-16)/2,width-Math.min(370,width-16)-8)),y:Math.max(8,Math.min(rect.bottom+5,height-480))});setBoardPickerOpen(true)
  }
  useEffect(()=>{setBoardPickerOpen(false)},[pageNumber,sidebarTab])
  function closeBoardPicker() {setBoardPickerOpen(false);boardTriggerRef.current?.focus?.()}
  function applyBoardChoice(spec: BoardChoice) {
    if(!validBoardSpec(spec))return
    if(boardTarget && 'groupId' in boardTarget) {
      const target=boardTarget
      const change=<T extends {groupId?:string;boardSpec?:BoardSpec|null;heightM?:number},>(record:Record<number,T[]>,wall=false)=>({...record,[target.page]:(record[target.page] ?? []).map(item=>{
        if(item.groupId!==target.groupId)return item
        const choice=spec ? {...spec} : spec
        if(choice){delete choice.heightOverrideMm;if(wall && item.heightM && item.heightM*1000>choice.lengthMm && spec?.heightOverrideMm!==undefined)choice.heightOverrideMm=item.heightM*1000}
        return {...item,boardSpec:choice}
      })})
      setLengthMeasurements(current=>change(current,true));setRunMeasurements(current=>change(current,true));setAreaMeasurements(current=>change(current));setCountMeasurements(current=>change(current))
    }
    else if(boardTarget && 'id' in boardTarget) {if(!savedMeasurement(boardTarget.id,boardTarget.page)){closeBoardPicker();return} updateMeasurementDetails(boardTarget.id,{boardSpec:spec},boardTarget.page)}
    else {const category=chooserCategoryId || activeCategory?.id || 'tack-ceiling';setBoardPreferences(current=>{const next={...current};if(spec===undefined)delete next[category];else next[category]=spec ? {...spec} : null;return next})}
    setBoardPendingSize(null);setBoardPendingSpec(null);closeBoardPicker()
  }
  function completeBoardSpec(spec: BoardSpec,override=false) {
    if(!validBoardSpec(spec))return
    const height=boardPickerHeight()
    const choice={...spec};delete choice.heightOverrideMm
    if(choice.boardType!=='INS' && height && choice.lengthMm+0.001<height*1000) {
      if(!override && Math.abs((boardDraftOverride ?? 0)-height*1000)>0.001){setBoardPendingSpec(choice);return}
      choice.heightOverrideMm=height*1000
    }
    applyBoardChoice(choice)
  }
  function selectBoardSize(width:number,length:number,override=false) {
    const height=boardPickerHeight()
    if(height && length+0.001<height*1000 && !override){setBoardPendingSize([width,length]);return}
    setBoardPendingSize(null);const approval=override && height ? height*1000 : undefined;setBoardDraftOverride(approval)
    if(boardDraftType==='THERMAL')setBoardStep('thickness')
    else completeBoardSpec({boardType:boardDraftType,thicknessMm:boardDraftThickness,widthMm:width,lengthMm:length},override)
  }
  function selectBoardThickness(thickness:number) {
    setBoardDraftThickness(thickness)
    if(boardDraftType==='INS')completeBoardSpec({boardType:'INS',thicknessMm:thickness,widthMm:0,lengthMm:0})
    else if(boardDraftType==='CELO' || boardDraftType==='THERMAL')completeBoardSpec({boardType:boardDraftType,thicknessMm:thickness,widthMm:1200,lengthMm:2400})
    else setBoardStep('size')
  }
  function workBoardField(groupId:string,number:number) {
    const items=[...(lengthMeasurements[number] ?? []),...(runMeasurements[number] ?? []),...(areaMeasurements[number] ?? []),...(countMeasurements[number] ?? [])].filter(item=>item.groupId===groupId)
    const labels=[...new Set(items.map(item=>boardSpecLabel(item.boardSpec)))],label=labels.length>1 ? 'Mixed board specifications' : labels[0] || 'Choose board specification'
    return <div className="work-board-editor"><label>Board Specification on this drawing</label><button type="button" className="board-spec-value" data-board-picker aria-label="Board specification for selected work" onClick={event=>openBoardPicker({groupId,page:number},event.currentTarget)}>{label}</button><p className="length-note">Changes apply to this work’s measurements on {drawingPageName(number)} only. Individual specifications can still be changed below.</p></div>
  }
  function measurementBoardField(id:string,number=pageNumber) {
    const saved=savedMeasurement(id,number);if(!saved)return null
    const spec=saved.item.boardSpec,height=saved.kind==='length' || saved.kind==='run' ? saved.item.heightM : undefined
    return <div className="measurement-board-field"><label>Board Specification</label><button type="button" className="board-spec-value" aria-label={'Board specification for '+id} data-board-picker onClick={event=>openBoardPicker({id,page:number},event.currentTarget)}>{boardSpecLabel(spec)}</button>{boardHeightMismatch(spec,height) && <p className="board-height-warning" role="alert">Board length is shorter than the wall height. Change the board or <button type="button" onClick={()=>{if(spec && height && window.confirm('Use '+spec.lengthMm+'mm boards for a '+Math.round(height*1000)+'mm wall height anyway?'))updateMeasurementDetails(id,{boardSpec:{...spec,heightOverrideMm:height*1000}},number)}}>Override and keep</button>.</p>}{spec?.heightOverrideMm!==undefined && !boardHeightMismatch(spec,height) && height && height*1000>spec.lengthMm && <p className="board-override-note">Board length override accepted for {Math.round(height*1000)}mm height.</p>}</div>
  }
  useEffect(()=>{
    if(!boardPickerOpen)return
    const outside=(event:PointerEvent)=>{if(!(event.target as Element | null)?.closest('[data-board-picker]'))setBoardPickerOpen(false)}
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeBoardPicker()}}
    const resize=()=>setBoardPickerOpen(false)
    window.addEventListener('pointerdown',outside);window.addEventListener('keydown',escape);window.addEventListener('resize',resize)
    return ()=>{window.removeEventListener('pointerdown',outside);window.removeEventListener('keydown',escape);window.removeEventListener('resize',resize)}
  },[boardPickerOpen])

  function measurementDetails(id: string, name = '', groupId = '') {
    return (
      <div className="measurement-details">{(savedMeasurement(id,pageNumber)?.item as LengthMeasurement | undefined)?.doorHead && <p className="door-head-note">Door head · 2000mm opening · both faces included</p>}{measurementBoardField(id)}<button className="duplicate-measurement-button" disabled={hasDraft} onClick={()=>requestDuplicate([id])}>Duplicate Measurement</button>
        <label>
          Name
          <input value={name} maxLength={100} placeholder="Optional measurement name"
            aria-label={`Name ${id}`}
            onChange={(event) => updateMeasurementDetails(id, { name: event.target.value })} />
        </label>
        <label>
          Group
          <select value={groupId} aria-label={`Group for ${id}`}
            onChange={(event) => updateMeasurementDetails(id, { groupId: event.target.value || undefined })}>
            <option value="">Ungrouped</option>
            {groups.filter((group) => id.startsWith('C') ? categories.find((category) => category.id === group.categoryId)?.mode === 'count'
              : categories.find((category) => category.id === group.categoryId)?.mode !== 'count')
              .map((group) => <option key={group.id} value={group.id}>{group.name.trim() || group.id}</option>)}
          </select>
        </label>
      </div>
    )
  }

  function addRunPoint(clientX: number, clientY: number) {
    if ((!runMode && readyToolKind !== 'run') || !hasValidCalibration()) return
    const point = clientToPdfPoint(clientX, clientY)
    if (!point) return
    if (readyToolKind === 'run') { setRunMode(true); setReadyToolKind(null); revealActiveGroup() }
    setRunPoints((current) => {
      const last = current[current.length - 1]
      // Ignore repeated clicks without preventing a return to an earlier corner.
      if (last && Math.hypot(point.x - last.x, point.y - last.y) < 0.000001) {
        return current
      }
      return [...current, point]
    })
  }

  function finishRun(options?: { allowHeightDraft?: boolean }) {
    if (toolHeightInvalid && !options?.allowHeightDraft) { setStatus('Enter a valid wall height or clear it before finishing.'); return }
    if (!runMode || runPoints.length < 2 || !hasValidCalibration()) return
    const id = `R${String(nextRunNumberRef.current++).padStart(3, '0')}`
    setRunMeasurements((current) => ({
      ...current,
      [pageNumber]: [...(current[pageNumber] ?? []), {
        id, points: [...runPoints], locked: true, ...boardSnapshot(), ...(activeGroupId ? { groupId: activeGroupId } : {}),
        ...(runHeightM !== undefined ? { heightM: runHeightM } : {}),
      }],
    }))
    setRunMode(false)
    setRunPoints([])
    setReadyToolKind('run')
    setStatus(`${id} finished and locked. Click the next start point to measure another run.`)
  }

  function cancelRun() {
    setReadyToolKind(null)
    setRunMode(false)
    setRunPoints([])
    setStatus('Unfinished run cancelled. Saved measurements are unchanged.')
  }

  function toggleRunLock(id: string) {
    const run = (runMeasurements[pageNumber] ?? []).find((item) => item.id === id)
    if (!run) return
    setRunMeasurements((current) => ({
      ...current,
      [pageNumber]: (current[pageNumber] ?? []).map((item) =>
        item.id === id ? { ...item, locked: !item.locked } : item),
    }))
    setStatus(run.locked
      ? `${id} unlocked. Drag any corner; both connected walls update together.`
      : `${id} locked. Its corners will not block new measurements.`)
  }

  function deleteRun(id: string) {
    setRunMeasurements((current) => ({
      ...current,
      [pageNumber]: (current[pageNumber] ?? []).filter((item) => item.id !== id),
    }))
    setStatus(`${id} deleted.`)
  }

  function startRunHandleDrag(
    event: React.PointerEvent<SVGCircleElement>, runId: string, pointIndex: number
  ) {
    if (event.button !== 0 || hasDraft || !hasValidCalibration()) return
    const run = (runMeasurements[pageNumber] ?? []).find((item) => item.id === runId)
    if (!run || run.locked) return
    event.stopPropagation()
    event.preventDefault()
    setSelectedEditPoint({id:runId,kind:'run',index:pointIndex,page:pageNumber})
    stageRef.current?.focus({preventScroll:true})
    runDragRef.current = { runId, pointIndex, pointerId: event.pointerId }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveRunHandle(event: React.PointerEvent<SVGCircleElement>) {
    readShift(event)
    const drag = runDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.stopPropagation()
    event.preventDefault()
    if (!hasValidCalibration()) return
    const point = clientToPdfPoint(event.clientX, event.clientY)
    if (!point) return
    setRunMeasurements((current) => ({
      ...current,
      [pageNumber]: (current[pageNumber] ?? []).map((run) => {
        if (run.id !== drag.runId || run.locked) return run
        // Do not collapse either adjoining segment to zero length.
        const neighbours = [run.points[drag.pointIndex - 1], run.points[drag.pointIndex + 1]]
        if (neighbours.some((p) => p && Math.hypot(p.x - point.x, p.y - point.y) < 0.000001)) return run
        return { ...run, points: run.points.map((p, i) => i === drag.pointIndex ? point : p) }
      }),
    }))
  }

  function endRunHandleDrag(event: React.PointerEvent<SVGCircleElement>) {
    if (runDragRef.current?.pointerId !== event.pointerId) return
    event.stopPropagation()
    event.preventDefault()
    runDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function startLengthMeasurement() {
    if (runMode || areaMode || countMode || activeIsCount) return
    revealActiveGroup()
    const calibration = calibrations[pageNumber]

    if (
      !calibration ||
      !calibration.locked ||
      calibration.needsRecalibration
    ) {
      setStatus(
        'Length measurement requires a valid locked calibration on this page.'
      )
      return
    }

    setCalibrationMode(false)
    setCalibrationPoints([])
    setPendingCalibration(null)
    setCalibrationDistance('')

    setLengthPoints([])
    setLengthMode(true)
    setStatus(
      'Length: click the first point. You can pan or zoom before placing the second point.'
    )
  }

  function cancelLengthMeasurement() {
    setToolDoorHead(false)
    setReadyToolKind(null)
    setLengthMode(false)
    setLengthPoints([])
    setStatus('Length measurement cancelled.')
  }

  function addLengthPoint(clientX: number, clientY: number) {
    if(toolDoorHead && !(Number(toolWallHeight)>2)){setStatus('Door heads need a wall height greater than 2000mm.');return}
    if (toolHeightInvalid) { setStatus('Enter a valid wall height or clear it before measuring.'); return }
    if (!lengthMode && readyToolKind !== 'length') return

    const calibration = calibrations[pageNumber]

    if (
      !calibration ||
      !calibration.locked ||
      calibration.needsRecalibration
    ) {
      setLengthMode(false)
      setLengthPoints([])
      setStatus(
        'Calibration is not valid. Recalibrate and lock the page before measuring.'
      )
      return
    }

    const newPoint = clientToPdfPoint(clientX, clientY)
    if (!newPoint) return
    if (readyToolKind === 'length') { setLengthMode(true); setReadyToolKind(null); revealActiveGroup() }

    if (lengthPoints.length === 0) {
      setLengthPoints([newPoint])
      setStatus(
        'Length: first point set. Pan or zoom as needed, then click the second point.'
      )
      return
    }

    const pointA = lengthPoints[0]
    const pointB = newPoint
    if(toolDoorHead && Math.hypot(pointB.x-pointA.x,pointB.y-pointA.y)<0.000001){setStatus('Click the other side of the doorway to give it a width.');return}
    const id = `L${String(nextLengthNumberRef.current).padStart(3, '0')}`
    nextLengthNumberRef.current += 1

    setLengthMeasurements((current) => ({
      ...current,
      [pageNumber]: [
        ...(current[pageNumber] ?? []),
        { id, pointA, pointB, locked: true, ...boardSnapshot(), ...(toolDoorHead ? {doorHead:true as const,heightM:Number(toolWallHeight)} : runHeightM !== undefined ? { heightM: runHeightM } : {}), ...(activeGroupId ? { groupId: activeGroupId } : {}) },
      ],
    }))

    setLengthPoints([])
    setLengthMode(false)
    setReadyToolKind('length')
    setStatus(
      toolDoorHead ? `Door head ${id} saved: ${wallAreaFromLength(Math.hypot(pointB.x-pointA.x,pointB.y-pointA.y)*calibration.mmPerPdfUnit,Number(toolWallHeight),true)!.toFixed(2)} m² for both faces. Click the next doorway.` : `${id} measured and locked. Untick Lock if you want to fine-tune its end points.`
    )
  }

  function updateLengthPoint(
    which: 'A' | 'B',
    point: Point,
    measurementId: string | null
  ) {
    const calibration = calibrations[pageNumber]

    if (
      !calibration ||
      !calibration.locked ||
      calibration.needsRecalibration
    ) {
      setStatus(
        'Calibration is not valid. Recalibrate and lock the page before editing measurements.'
      )
      return
    }

    if (!measurementId && lengthPoints.length === 1 && which === 'A') {
      setLengthPoints([point])
      return
    }

    if (!measurementId) return

    setLengthMeasurements((current) => ({
      ...current,
      [pageNumber]: (current[pageNumber] ?? []).map((measurement) => {
        if (measurement.id !== measurementId || measurement.locked) {
          return measurement
        }

        return which === 'A'
          ? { ...measurement, pointA: point }
          : { ...measurement, pointB: point }
      }),
    }))
  }

  function startLengthHandleDrag(
    event: React.PointerEvent<SVGCircleElement>,
    which: 'A' | 'B',
    measurementId: string | null
  ) {
    if (event.button !== 0) return
    event.stopPropagation()
    event.preventDefault()

    const calibration = calibrations[pageNumber]

    if (
      !calibration ||
      !calibration.locked ||
      calibration.needsRecalibration
    ) {
      setStatus(
        'Calibration is not valid. Recalibrate and lock the page before editing measurements.'
      )
      return
    }

    if (measurementId) {
      const measurement = (lengthMeasurements[pageNumber] ?? []).find(
        (item) => item.id === measurementId
      )

      if (measurement?.locked) {
        return
      }
    }

    if (measurementId) {setSelectedEditPoint({id:measurementId,kind:'length',index:which==='A' ? 0 : 1,page:pageNumber});stageRef.current?.focus({preventScroll:true})}
    lengthDragRef.current = {
      point: which,
      measurementId,
      pointerId: event.pointerId,
    }

    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveLengthHandle(
    event: React.PointerEvent<SVGCircleElement>
  ) {
    readShift(event)
    const drag = lengthDragRef.current

    if (!drag.point || drag.pointerId !== event.pointerId) return

    event.stopPropagation()
    event.preventDefault()

    const point = clientToPdfPoint(event.clientX, event.clientY)

    if (point) {
      updateLengthPoint(drag.point, point, drag.measurementId)
    }
  }

  function endLengthHandleDrag(
    event: React.PointerEvent<SVGCircleElement>
  ) {
    const drag = lengthDragRef.current

    if (!drag.point || drag.pointerId !== event.pointerId) return

    event.stopPropagation()
    event.preventDefault()

    lengthDragRef.current = {
      point: null,
      measurementId: null,
      pointerId: -1,
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function toggleLengthLock(measurementId: string) {
    let lockedNow = false

    setLengthMeasurements((current) => ({
      ...current,
      [pageNumber]: (current[pageNumber] ?? []).map((measurement) => {
        if (measurement.id !== measurementId) return measurement

        lockedNow = !measurement.locked

        return {
          ...measurement,
          locked: lockedNow,
        }
      }),
    }))

    setStatus(
      lockedNow
        ? `${measurementId} locked. Its end points will no longer block new measurements.`
        : `${measurementId} unlocked. You can drag its end points again.`
    )
  }

  function deleteLengthMeasurement(measurementId: string) {
    setLengthMeasurements((current) => ({
      ...current,
      [pageNumber]: (current[pageNumber] ?? []).filter(
        (measurement) => measurement.id !== measurementId
      ),
    }))

    setStatus(`${measurementId} deleted.`)
  }

  function clearAllLengths() {
    setLengthMode(false)
    setLengthPoints([])

    setLengthMeasurements((current) => ({
      ...current,
      [pageNumber]: [],
    }))

    setStatus('All length measurements cleared from this page.')
  }

  function startCalibration() {
    setToolDoorHead(false)
    setCalibrationVisible(true)
    setReadyToolKind(null)
    if (!pdf || runMode || areaMode || countMode) return

    setLengthMode(false)
    setLengthPoints([])

    setCalibrationPoints([])
    setPendingCalibration(null)
    setCalibrationDistance('')
    setCalibrationMode(true)
    setStatus('Calibration: click the first end of a known dimension.')
  }

  function cancelCalibration() {
    setCalibrationMode(false)
    setCalibrationPoints([])
    setPendingCalibration(null)
    setCalibrationDistance('')
    setStatus('Calibration cancelled.')
  }

  function saveCalibration() {
    if (!pendingCalibration) return

    const distanceMm = Number(calibrationDistance.trim())

    if (!Number.isFinite(distanceMm) || distanceMm <= 0) {
      setStatus('Enter a valid distance greater than 0 mm.')
      return
    }

    const { pointA, pointB } = pendingCalibration
    const dx = pointB.x - pointA.x
    const dy = pointB.y - pointA.y
    const pdfDistance = Math.sqrt(dx * dx + dy * dy)

    if (!Number.isFinite(pdfDistance) || pdfDistance <= 0) {
      setStatus('Calibration points must be different.')
      return
    }

    setCalibrations((current) => ({
      ...current,
      [pageNumber]: {
        pointA,
        pointB,
        distanceMm,
        mmPerPdfUnit: distanceMm / pdfDistance,
        locked: true,
        needsRecalibration: false,
      },
    }))

    setPendingCalibration(null)
    setCalibrationPoints([])
    setCalibrationDistance('')
    setStatus(`Page ${pageNumber} calibrated to ${distanceMm.toLocaleString()} mm ✓`)
  }

  function unlockCalibration() {
    setCalibrationVisible(true)
    if (runMode || areaMode || countMode) return
    setRecalibrationDistance('')

    setCalibrations((current) => {
      const existing = current[pageNumber]
      if (!existing) return current

      return {
        ...current,
        [pageNumber]: {
          ...existing,
          locked: false,
        },
      }
    })

    setStatus(
      'Calibration unlocked. Drag A or B to fine-tune. If either point moves, recalibration will be required.'
    )
  }

  function lockCalibration() {
    setCalibrations((current) => {
      const existing = current[pageNumber]
      if (!existing || existing.needsRecalibration) return current

      return {
        ...current,
        [pageNumber]: {
          ...existing,
          locked: true,
        },
      }
    })

    setStatus('Calibration locked.')
  }

  function recalibrateCurrentPoints() {
    const existing = calibrations[pageNumber]
    if (!existing) return

    const newDistanceMm = Number(recalibrationDistance.trim())

    if (!Number.isFinite(newDistanceMm) || newDistanceMm <= 0) {
      setStatus('Enter the new known distance in millimetres before recalibrating.')
      return
    }

    const dx = existing.pointB.x - existing.pointA.x
    const dy = existing.pointB.y - existing.pointA.y
    const pdfDistance = Math.sqrt(dx * dx + dy * dy)

    if (!Number.isFinite(pdfDistance) || pdfDistance <= 0) {
      setStatus('Calibration points must be different.')
      return
    }

    setCalibrations((current) => ({
      ...current,
      [pageNumber]: {
        ...existing,
        distanceMm: newDistanceMm,
        mmPerPdfUnit: newDistanceMm / pdfDistance,
        locked: true,
        needsRecalibration: false,
      },
    }))

    setRecalibrationDistance('')

    setStatus(
      `Page ${pageNumber} recalibrated to ${newDistanceMm.toLocaleString()} mm and locked ✓`
    )
  }

  function clearCalibration() {
    if (runMode || areaMode || countMode) return
    setCalibrationVisible(true)
    setCalibrationMode(false)
    setCalibrations((current) => {
      const updated = { ...current }
      delete updated[pageNumber]
      return updated
    })

    setCalibrationPoints([])
    setPendingCalibration(null)
    setCalibrationDistance('')
    setRecalibrationDistance('')
    setStatus(`Calibration removed from page ${pageNumber}.`)
  }

  useEffect(() => {
    if (!pdf || (sidebarTab === 'summary' || sidebarTab === 'materials' || sidebarTab === 'export' || sidebarTab === 'rates' || sidebarTab === 'contractor-rates') || viewMode !== 'fit-page') return

    let cancelled = false

    async function applyFitPage() {
      const fittedScale = await calculateFitPageScale(
        pdf!,
        pageNumber,
        rotation
      )

      if (!cancelled) {
        setScale(fittedScale)
      }
    }

    applyFitPage()

    return () => {
      cancelled = true
    }
  }, [pdf, pageNumber, rotation, viewMode, stageResizeTick, sidebarTab])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return

    let resizeTimer: number | undefined

    const observer = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer)

      resizeTimer = window.setTimeout(() => {
        setStageResizeTick((tick) => tick + 1)
      }, 80)
    })

    observer.observe(stage)

    return () => {
      window.clearTimeout(resizeTimer)
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    if (!pdf || (sidebarTab === 'summary' || sidebarTab === 'materials' || sidebarTab === 'export' || sidebarTab === 'rates' || sidebarTab === 'contractor-rates') || !canvasRef.current) return

    const document = pdf
    let disposed = false

    async function renderPage() {
      setDrawingRenderError('');setDrawingRendering(true)
      try {
      const page = await document.getPage(pageNumber)

      if (disposed) return

      if (pdfSnapCache.current.doc !== document) pdfSnapCache.current = { doc: document, pages: new Map() }
      if (!pdfSnapCache.current.pages.has(pageNumber)) {
        setPdfSnapInfo('Reading PDF lines…')
        try {
          const operators = await page.getOperatorList()
          if (disposed) return
          const segments = pdfLineSegments(operators, pdfjsLib.OPS)
          pdfSnapCache.current.pages.set(pageNumber, makeSnapIndex(segments, 'PDF'))
          setPdfSnapInfo(segments.length ? (segments.length >= 100000 ? 'Complex PDF: some lines available. Manual placement is always available.' : 'PDF lines ready.') : 'No vector lines on this page. Use measurement snapping or place points manually.')
        } catch {
          if (disposed) return
          pdfSnapCache.current.pages.set(pageNumber, new Map())
          setPdfSnapInfo('PDF lines unavailable. Manual placement is always available.')
        }
      } else setPdfSnapInfo(pdfSnapCache.current.pages.get(pageNumber)!.size ? 'PDF lines ready.' : 'No vector lines on this page. Place points manually.')
      if (disposed) return
      const viewport = page.getViewport({
        scale,
        rotation,
      })

      viewportRef.current = viewport

      if (disposed) return

      setViewportSize({
        width: viewport.width,
        height: viewport.height,
      })

      const canvas = canvasRef.current
      if (!canvas) return
      const previous=renderTaskRef.current
      if(previous){try{previous.cancel();await previous.promise}catch{/* Cancellation is expected during zoom/page changes. */}}
      if(disposed)return

      const context = canvas.getContext('2d')
      if (!context) throw new Error('The browser could not allocate a drawing canvas.')

      const outputScale = pdfCanvasScale(viewport.width,viewport.height)

      canvas.width = Math.floor(viewport.width * outputScale)
      canvas.height = Math.floor(viewport.height * outputScale)
      canvas.style.width = `${Math.floor(viewport.width)}px`
      canvas.style.height = `${Math.floor(viewport.height)}px`

      const transform =
        outputScale !== 1
          ? ([
              outputScale,
              0,
              0,
              outputScale,
              0,
              0,
            ] as [number, number, number, number, number, number])
          : undefined

      try {
        renderTaskRef.current?.cancel()
      } catch {
        // Nothing to cancel.
      }

      const renderTask = page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform,
      })

      renderTaskRef.current = renderTask

      try {
        await renderTask.promise
      } catch (error: any) {
        if (error?.name !== 'RenderingCancelledException') {
          throw error
        }
      }
      } catch (failure: any) {
        if(!disposed && failure?.name!=='RenderingCancelledException') {
          console.error(failure)
          setDrawingRenderError('The PDF imported, but this browser could not display the drawing. '+String(failure?.message || 'Rendering failed.').slice(0,180))
        }
      } finally {if(!disposed)setDrawingRendering(false)}
    }

    void renderPage()

    return () => {
      disposed = true

      try {
        renderTaskRef.current?.cancel()
      } catch {
        // Ignore cancellation errors during cleanup.
      }
    }
  }, [pdf, pageNumber, scale, rotation, sidebarTab, drawingRenderRetry])

  const currentCalibration = calibrations[pageNumber]

  // Draft calibration must replace the saved overlay while new points are placed.
  const editingCalibration = calibrationMode || !!pendingCalibration
  const lineSource = editingCalibration ? pendingCalibration : currentCalibration

  let calibrationLine:
    | { x1: number; y1: number; x2: number; y2: number }
    | null = null

  if (lineSource && viewportRef.current) {
    const [x1, y1] = viewportRef.current.convertToViewportPoint(
      lineSource.pointA.x,
      lineSource.pointA.y
    )
    const [x2, y2] = viewportRef.current.convertToViewportPoint(
      lineSource.pointB.x,
      lineSource.pointB.y
    )

    calibrationLine = { x1, y1, x2, y2 }
  }

  let pointAHandle: { x: number; y: number } | null = null
  let pointBHandle: { x: number; y: number } | null = null

  const handleSourceA = editingCalibration
    ? pendingCalibration?.pointA ?? calibrationPoints[0] ?? null
    : currentCalibration?.pointA ?? null
  const handleSourceB = editingCalibration
    ? pendingCalibration?.pointB ?? calibrationPoints[1] ?? null
    : currentCalibration?.pointB ?? null

  if (handleSourceA && viewportRef.current) {
    const [x, y] = viewportRef.current.convertToViewportPoint(
      handleSourceA.x,
      handleSourceA.y
    )
    pointAHandle = { x, y }
  }

  if (handleSourceB && viewportRef.current) {
    const [x, y] = viewportRef.current.convertToViewportPoint(
      handleSourceB.x,
      handleSourceB.y
    )
    pointBHandle = { x, y }
  }

  const currentLengthMeasurements = lengthMeasurements[pageNumber] ?? []

  const lengthCalibrationValid =
    !!currentCalibration &&
    currentCalibration.locked &&
    !currentCalibration.needsRecalibration

  function runSegments(points: Point[]) {
    return points.slice(1).map((point, i) => {
      const start = points[i]
      return Math.hypot(point.x - start.x, point.y - start.y)
        * (currentCalibration?.mmPerPdfUnit ?? 0)
    })
  }

  const currentRuns = runMeasurements[pageNumber] ?? []
  const allMeasurements: Array<{ id: string; name?: string; groupId?: string; categoryId?: string; boardSpec?: BoardSpec | null; doorHead?: true; page: number; pdfLength: number; pdfArea: number; heightM?: number; kind: 'wall' | 'area' | 'count' }> = [
    ...Object.entries(lengthMeasurements).flatMap(([page, items]) => items.map((item) => ({
      ...item, page: Number(page), pdfLength: Math.hypot(item.pointB.x - item.pointA.x, item.pointB.y - item.pointA.y), pdfArea: 0, kind: 'wall' as const,
    }))),
    ...Object.entries(runMeasurements).flatMap(([page, items]) => items.map((item) => ({
      ...item, page: Number(page), pdfArea: 0, kind: 'wall' as const, pdfLength: item.points.slice(1).reduce((sum, point, i) =>
        sum + Math.hypot(point.x - item.points[i].x, point.y - item.points[i].y), 0),
    }))),
    ...Object.entries(areaMeasurements).flatMap(([page, items]) => items.map((item) => ({
      ...item, page: Number(page), pdfLength: 0, pdfArea: polygonArea(item.points), kind: 'area' as const,
    }))),
    ...Object.entries(countMeasurements).flatMap(([page, items]) => items.map((item) => ({
      ...item, categoryId: countCategoryId(item), page: Number(page), pdfLength: 0, pdfArea: 0, kind: 'count' as const,
    }))),
  ]
  function summarizeWork(group: MeasurementGroup, members: typeof allMeasurements) {
    const invalidPages = [...new Set(members.filter((item) => {
      const calibration = calibrations[item.page]
      return item.kind !== 'count' && (!calibration || !calibration.locked || calibration.needsRecalibration)
    }).map((item) => item.page))].sort((a, b) => a - b)
    const totalMm = invalidPages.length ? null : members.reduce((sum, item) =>
      sum + (item.kind === 'count' || item.doorHead ? 0 : item.pdfLength * calibrations[item.page].mmPerPdfUnit), 0)
    const invalidHeightIds = members.filter((item) => {
      const text = heightDrafts[item.id]
      return item.kind === 'wall' && ((item.doorHead && !(item.heightM!==undefined && item.heightM>2)) || text !== undefined && text !== '' && (!Number.isFinite(Number(text)) || Number(text) <= 0))
    }).map((item) => item.id)
    const totalAreaM2 = invalidPages.length || invalidHeightIds.length ? null : members.reduce((sum, item) => {
      if (item.kind === 'count') return sum
      const mmPerUnit = calibrations[item.page].mmPerPdfUnit
      return sum + (item.kind === 'area' ? item.pdfArea * mmPerUnit ** 2 / 1000000
        : item.heightM === undefined ? 0 : (wallAreaFromLength(item.pdfLength*mmPerUnit,item.heightM,!!item.doorHead) ?? 0))
    }, 0)
    const wallsWithoutHeight = members.filter((item) => item.kind === 'wall' && item.heightM === undefined).length
    return { ...group, members, invalidPages, totalMm, totalAreaM2, wallsWithoutHeight, invalidHeightIds,
      count: members.filter((item) => item.kind === 'count').length }
  }
  const groupSummaries = groups.map((group) => summarizeWork(group, allMeasurements.filter((item) => item.groupId === group.id)))
  const currentPageGroupSummaries = groups.map((group) => summarizeWork(group, allMeasurements.filter((item) => item.groupId === group.id && item.page === pageNumber))).filter((group) => group.members.length > 0)
  function summarizeCategories(work: ReturnType<typeof summarizeWork>[], scopePage?: number) { return categories.map((category) => {
    const sourceGroups = work.filter((group) => category.mode === 'derived'
      ? group.includeSkim !== false && categories.find((item) => item.id === group.categoryId)?.skimTarget === (category.id === 'skimmed-walls' ? 'walls' : 'ceilings')
      : group.categoryId === category.id)
    const totalMm = category.mode === 'derived' ? 0 : sourceGroups.some((group) => group.totalMm === null) ? null
      : sourceGroups.reduce((sum, group) => sum + (group.totalMm ?? 0), 0)
    const totalAreaM2 = sourceGroups.some((group) => group.totalAreaM2 === null) ? null
      : sourceGroups.reduce((sum, group) => sum + (group.totalAreaM2 ?? 0), 0)
    return { ...category, sourceGroups, totalMm, totalAreaM2,
      count: category.mode === 'count' ? allMeasurements.filter((item) => item.kind === 'count' && item.categoryId === category.id && (scopePage === undefined || item.page === scopePage)).length : 0,
      wallsWithoutHeight: sourceGroups.reduce((sum, group) => sum + group.wallsWithoutHeight, 0) }
  })
  }
  const categorySummaries = summarizeCategories(groupSummaries)
  const measuredCategorySummaries = categorySummaries.filter((category) => category.mode === 'count' ? category.count > 0
    : category.sourceGroups.some((group) => group.members.some((item) => category.mode !== 'derived' || item.kind === 'area' || (item.kind === 'wall' && item.heightM !== undefined))))
  function workHeading(id:string) {
    const category=categories.find(item=>item.id===id)
    return category ? categoryWorkHeading(category) : ''
  }
  function priceSubtotals(rows:Array<{id:string;mode:string;totalAreaM2:number|null;count:number}>,scope:string) {
    const sections=[{name:'Tack & Ins Total',headings:['Tack','Insulation']},{name:'Dab Total',headings:['Dab']},{name:'Skim Total',headings:['Skim']}]
    return <div className="trade-subtotals" aria-label={'Trade subtotals for '+scope}>{sections.map(section=>{const matching=rows.filter(row=>section.headings.includes(workHeading(row.id))),prices=matching.map(workPrice),missing=prices.filter(price=>price.value===null).length,total=prices.reduce((sum,price)=>sum+(price.value ?? 0),0);return <div className="trade-subtotal" key={section.name}><span>{section.name}</span><strong>{pounds(total)}</strong>{missing>0 && <small>{missing} awaiting pricing / quantities</small>}</div>})}</div>
  }
  function finalMaterialQuantity(exact:number|null,id?:string) {
    if(exact===null || !(id && materialWasteDrafts[id]!==undefined ? validWaste(materialWasteDrafts[id]) : validWaste(materialWasteText)))return null
    const value=exact*(1+(id ? materialWasteOverrides[id] ?? materialWastePercent : materialWastePercent)/100)
    if(!Number.isFinite(value))return null
    const result=Math.ceil(Number(value.toPrecision(12)))
    return Number.isSafeInteger(result) ? result : null
  }
  const materialScopePage=materialDrawingKey==='all' ? undefined : drawingPages.findIndex(page=>page.source+':'+page.page===materialDrawingKey)+1 || undefined
  useEffect(()=>{if(materialDrawingKey!=='all' && !drawingPages.some(page=>page.source+':'+page.page===materialDrawingKey))setMaterialDrawingKey('all')},[drawingPages,materialDrawingKey])
  useEffect(()=>{
    const update=()=>{if(typeof navigator!=='undefined')setTabletLandscape(isIpadLandscape(navigator.userAgent,navigator.platform,navigator.maxTouchPoints,window.innerWidth,window.innerHeight))}
    update();window.addEventListener('resize',update);window.visualViewport?.addEventListener('resize',update)
    return ()=>{window.removeEventListener('resize',update);window.visualViewport?.removeEventListener('resize',update)}
  },[])
  function calculateMaterials(trade:MaterialTrade=materialTrade,scopePage:number|undefined=materialScopePage) {
    const scopedMeasurements=allMeasurements.filter(item=>scopePage===undefined || item.page===scopePage)
    const scopedGroups=groups.map(group=>summarizeWork(group,scopedMeasurements.filter(item=>item.groupId===group.id))).filter(group=>group.members.length)
    const scopedCategories=summarizeCategories(scopedGroups,scopePage).filter(category=>category.mode!=='count' && category.sourceGroups.some(group=>group.members.some(item=>category.mode!=='derived' || item.kind==='area' || item.heightM!==undefined)))
    const matchesTrade=(item:typeof allMeasurements[number])=>trade==='all' || workHeading(groups.find(group=>group.id===item.groupId)?.categoryId ?? item.categoryId ?? '')===trade
    const boards=new Map<string,{id:string;label:string;areaM2:number;incomplete:boolean;boardAreaM2:number}>(),issues:string[]=[]
    let measuredAreaM2=0,unknownAreas=0
    for(const measurement of scopedMeasurements) {
      if(measurement.kind==='count' || !matchesTrade(measurement))continue
      const quantity=withQuantities(measurement),area=quantity.areaM2,spec=measurement.boardSpec,label=(measurement.name || measurement.id)+' · '+drawingPageName(measurement.page)
      if(area===null){unknownAreas++;issues.push(label+': check calibration and wall height.')}else measuredAreaM2+=area
      if(spec===undefined){issues.push(label+': choose a board specification, or Not applicable.');continue}
      if(spec===null)continue
      const key=spec.boardType+'|'+spec.thicknessMm+'|'+spec.widthMm+'|'+spec.lengthMm,boardAreaM2=spec.boardType==='INS' ? materialCoverage.insulation[String(spec.thicknessMm)] : spec.widthMm*spec.lengthMm/1000000
      const row=boards.get(key) ?? {id:key,label:boardSpecLabel(spec).replace(spec.boardType,'('+spec.boardType+')'),areaM2:0,incomplete:false,boardAreaM2}
      const mismatch=measurement.kind==='wall' && boardHeightMismatch(spec,measurement.heightM)
      if(mismatch)issues.push(label+': board length is shorter than wall height; confirm an override or change the board.')
      if(area===null || mismatch || boardAreaM2<=0)row.incomplete=true
      if(area!==null)row.areaM2+=area
      boards.set(key,row)
    }
    const rows=Array.from(boards.values()).map(row=>{const exact=row.incomplete ? null : row.areaM2/row.boardAreaM2;return {...row,unit:row.id.startsWith('INS|') ? 'rolls' : 'boards',exact,final:finalMaterialQuantity(exact,row.id),coverage:row.boardAreaM2}})
    const bagRows:Array<{id:string;label:string;areaM2:number;incomplete:boolean;coverage:number;exact:number|null;final:number|null;unit:string}>=[]
    for(const bag of [{id:'adhesive',label:'Dabbing adhesive',coverage:materialCoverage.adhesive,source:scopedCategories.filter(category=>(trade==='all' || trade==='Dab') && workHeading(category.id)==='Dab' && category.mode!=='count')},{id:'skim',label:'Skimming plaster',coverage:materialCoverage.skim,source:scopedCategories.filter(category=>(trade==='all' || trade==='Skim') && workHeading(category.id)==='Skim' && category.mode!=='count')}]) {
      if(!bag.source.length)continue
      const incomplete=bag.coverage<=0 || bag.source.some(category=>category.totalAreaM2===null || category.wallsWithoutHeight>0),areaM2=bag.source.reduce((sum,category)=>sum+(category.totalAreaM2 ?? 0),0),exact=incomplete ? null : areaM2/bag.coverage
      bagRows.push({id:bag.id,label:bag.label,areaM2,incomplete,coverage:bag.coverage,exact,final:finalMaterialQuantity(exact,bag.id),unit:'bags'})
      if(incomplete)issues.push(bag.label+(bag.coverage<=0 ? ': enter positive m² coverage per bag.' : ': quantities are incomplete; check calibration and wall heights in the source work.'))
    }
    return {boards:rows.filter(row=>row.unit==='boards'),rolls:rows.filter(row=>row.unit==='rolls'),bags:bagRows,issues,measuredAreaM2,unknownAreas}
  }
  const materialSummary=sidebarTab==='materials' ? calculateMaterials() : null
  const wholePlotMaterials=materialTrade==='all' && materialScopePage===undefined
  const materialScopeLabel=(materialTrade==='all' ? 'All trades' : materialTrade)+' · '+(materialScopePage===undefined ? 'All drawings' : drawingPageName(materialScopePage))
  const shownAdhesiveCoverage=!!materialSummary?.bags.some(row=>row.id==='adhesive'),shownSkimCoverage=!!materialSummary?.bags.some(row=>row.id==='skim')
  const shownInsulationThicknesses=new Set(materialSummary?.rolls.map(row=>row.id.split('|')[1]) ?? [])
  function materialsTable(rows:Array<{id:string;label:string;areaM2:number;coverage:number;incomplete:boolean;exact:number|null;final:number|null;unit:string}>,label:string) {
    return <div className="material-table-wrap"><table className="material-table" aria-label={label}><colgroup><col className="material-col-spec" /><col className="material-col-area" /><col className="material-col-exact" /><col className="material-col-waste" /><col className="material-col-final" /></colgroup><thead><tr><th>Material / specification</th><th>Measured m²</th><th>Exact</th><th>Waste (%)</th><th>Final order</th></tr></thead><tbody>{rows.map(row=><tr key={row.id}><th scope="row">{row.label}<small>{row.coverage>0 ? row.coverage.toFixed(2)+'m² per '+(row.unit==='boards' ? 'board' : row.unit==='rolls' ? 'roll' : 'bag') : 'Enter positive coverage'}</small></th><td>{row.incomplete ? 'Check quantities' : row.areaM2.toFixed(2)+' m²'}</td><td>{row.exact===null ? 'Check quantities' : row.exact.toFixed(2)+' '+row.unit}</td><td><input className="material-row-waste" type="number" min="0" step="any" inputMode="decimal" aria-label={row.label+' waste percentage'} value={materialWasteDrafts[row.id] ?? materialWasteText} aria-invalid={!validWaste(materialWasteDrafts[row.id] ?? materialWasteText)} onChange={event=>setMaterialWasteDrafts(current=>({...current,[row.id]:event.target.value}))} /></td><td><strong>{row.final===null ? hasInvalidWaste ? 'Check waste %' : 'Check quantities' : row.final+' '+row.unit}</strong></td></tr>)}</tbody></table></div>
  }

  function setWorkRate(kind:'subcontractor'|'contractor',id:string,text:string) {
    if(!categories.some(category=>category.id===id))return
    const key=kind+':'+id;setRateDrafts(current=>({...current,[key]:text}))
    if(kind==='subcontractor')setClearedSubcontractorRates(current=>text==='' ? [...new Set([...current,id])] : validRateText(text) ? current.filter(key=>key!==id) : current)
    const setter=kind==='subcontractor' ? setSubcontractorRates : setContractorRates
    if(text==='')setter(current=>{const next={...current};delete next[id];return next})
    else if(validRateText(text))setter(current=>({...current,[id]:Number(text)}))
  }
  function workPrice(row:{id:string;mode:string;totalAreaM2:number|null;count:number}) {
    const draft=rateDrafts['subcontractor:'+row.id]
    if(draft!==undefined && draft!=='' && !validRateText(draft))return {value:null,note:'Correct rate'}
    const rate=subcontractorRates[row.id]
    if(rate===undefined)return {value:null,note:'Rate not set'}
    const quantity=row.mode==='count' ? row.count : row.totalAreaM2
    if(quantity===null)return {value:null,note:'Check calibration / heights'}
    const raw=quantity*rate
    if(!Number.isFinite(raw) || !Number.isSafeInteger(Math.round(raw*100)))return {value:null,note:'Value too large'}
    return {value:roundWorkValue(raw),note:quantity.toFixed(row.mode==='count' ? 0 : 2)+(row.mode==='count' ? ' items' : ' m²')+' × £'+rate.toLocaleString('en-GB',{maximumFractionDigits:6})+(row.mode==='count' ? ' per item' : '/m²')}
  }
  function workPriceLabel(row:{id:string;name:string;mode:string;totalAreaM2:number|null;count:number}) {
    const price=workPrice(row)
    const rate=subcontractorRates[row.id],draft=rateDrafts['subcontractor:'+row.id],valid=rate!==undefined && (draft===undefined || draft==='' || validRateText(draft))
    return <span className="work-price-detail">{valid && <span className="work-rate" aria-label={'Subcontractor rate for '+row.name}>{'£'+rate.toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:6})+(row.mode==='count' ? ' / item' : ' / m²')}</span>}<span className={'work-price'+(price.value===null ? ' is-unpriced' : '')} aria-label={'Subcontractor value for '+row.name} title={price.note}>{price.value===null ? price.note : pounds(price.value)}</span></span>
  }
  function rateInput(kind:'subcontractor'|'contractor',category:QuantityPriceRow) {
    const book=kind==='subcontractor' ? subcontractorRates : contractorRates,key=kind+':'+category.id,text=rateDrafts[key] ?? (book[category.id]===undefined ? '' : String(book[category.id])),invalid=text!=='' && !validRateText(text)
    return <label className="rate-table-field"><span>{category.mode==='count' ? '£ per item' : '£ per m²'}</span><input type="number" min="0" step="any" inputMode="decimal" placeholder="Enter rate" value={text} aria-label={(kind==='subcontractor' ? 'Subcontractor' : 'Contractor')+' rate for '+category.name} aria-invalid={invalid} onChange={event=>setWorkRate(kind,category.id,event.target.value)} />{invalid && <small role="alert">Enter zero or a positive rate, or clear the box.</small>}</label>
  }
  function ratesPanel(kind:'subcontractor'|'contractor') {
    return <div hidden={sidebarTab!==(kind==='subcontractor' ? 'rates' : 'contractor-rates')} className="rates-panel"><h2>{kind==='subcontractor' ? 'Subcontractor Rates' : 'Contractor Rates'}</h2><p className="length-note">{kind==='subcontractor' ? 'Enter rates in the table. These are used in Plot Summary.' : 'Reference rates, saved separately. These do not change Plot Summary pricing.'}</p><p className="length-note">{measuredCategorySummaries.length} measured categories · all drawings</p></div>
  }
  function quantityCells(row:QuantityPriceRow) {
    return <><td>{row.mode==='count' ? '—' : row.totalAreaM2===null ? 'Check quantities' : row.totalAreaM2.toFixed(2)}</td><td>{row.mode==='count' || row.mode==='derived' ? '—' : row.totalMm===null ? 'Check calibration' : (row.totalMm/1000).toFixed(2)}</td><td>{row.mode==='count' || row.count>0 ? row.count : '—'}</td></>
  }
  function quantityName(row:QuantityPriceRow) {
    return <>{row.name}{row.mode==='derived' && <small>Automatic skim · reuses Tack / Dab areas</small>}{!!row.wallsWithoutHeight && <small className="quantity-table-warning">{row.wallsWithoutHeight} lengths / runs need a wall height for m².</small>}</>
  }
  function summaryRateText(row:QuantityPriceRow) {
    const draft=rateDrafts['subcontractor:'+row.id],rate=subcontractorRates[row.id]
    return draft!==undefined && draft!=='' && !validRateText(draft) ? 'Correct rate' : rate===undefined ? 'Rate not set' : '£'+rate.toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:6})+(row.mode==='count' ? ' / item' : ' / m²')
  }
  function summaryBlock(row:QuantityPriceRow) {
    const category=categories.find(category=>category.id===row.id),heading=category ? categoryWorkHeading(category) : ''
    return heading==='Tack' || heading==='Insulation' ? 'Tack & Insulation' : heading==='Dab' ? 'Dab' : heading==='Skim' ? 'Skim' : heading==='Metal' ? 'Metal Work' : 'Other Work'
  }
  function summaryRank(row:QuantityPriceRow) {
    const category=categories.find(category=>category.id===row.id),heading=category ? categoryWorkHeading(category) : '',name=row.name.toLowerCase()
    if(heading==='Tack')return row.mode==='count' ? 50 : row.id==='tack-ceiling' ? 10 : /ceiling/.test(name) ? 11 : ['tack-timber-wall','tack-metal-wall'].includes(row.id) ? 20 : /wall|stud/.test(name) ? 21 : 30
    if(heading==='Insulation')return 40
    if(heading==='Dab')return row.mode==='count' ? 80 : row.id==='dabbed-external-wall' ? 60 : /external/.test(name) ? 61 : row.id==='dabbed-internal-wall' ? 70 : /internal/.test(name) ? 71 : 75
    if(heading==='Skim')return row.mode==='count' ? 110 : row.id==='skimmed-ceiling' ? 90 : /ceiling/.test(name) ? 91 : row.id==='skimmed-walls' ? 100 : /wall/.test(name) ? 101 : 105
    if(heading==='Metal')return row.mode==='count' ? 210 : 200
    return 120
  }
  function orderedSummaryRows<T extends QuantityPriceRow>(rows:T[]):T[] {return [...rows].sort((a,b)=>summaryRank(a)-summaryRank(b) || a.name.localeCompare(b.name,'en-GB',{numeric:true,sensitivity:'base'}) || a.id.localeCompare(b.id))}
  function summaryTotals(rows:QuantityPriceRow[],scope:string) {
    const prices=rows.map(workPrice),missing=prices.filter(price=>price.value===null).length,total=prices.reduce((sum,price)=>sum+(price.value ?? 0),0)
    return <div className="tabular-summary-totals" aria-label={'Subcontractor totals for '+scope}>{priceSubtotals(rows,scope)}<div className="plot-price-total"><span>{missing ? 'Priced subcontractor subtotal' : scope==='whole plot' ? 'Plot subcontractor total' : 'Drawing subcontractor total'}</span><strong>{pounds(total)}</strong>{missing>0 && <p>{missing} work items awaiting rates or valid quantities.</p>}</div></div>
  }
  function loginContractor() {
    if(contractorLoginId.trim()==='holmes' && contractorPassword==='1234'){setContractorUnlocked(true);setContractorLoginId('');setContractorPassword('');setContractorLoginError('')}
    else {setContractorLoginError('ID or password is incorrect.');setContractorPassword('')}
  }
  function lockContractorRates() {setContractorUnlocked(false);setContractorLoginId('');setContractorPassword('');setContractorLoginError('')}
  function ratesWorkspace(kind:'subcontractor'|'contractor') {
    if(kind==='contractor' && !contractorUnlocked)return <section className="summary-gallery rates-workspace" aria-label="Contractor Rates login"><article className="material-order-card contractor-login-card"><h2>Contractor Rates</h2><form onSubmit={event=>{event.preventDefault();loginContractor()}}><label>ID<input autoComplete="username" aria-label="Contractor login ID" value={contractorLoginId} onChange={event=>setContractorLoginId(event.target.value)} /></label><label>Password<input type="password" autoComplete="current-password" aria-label="Contractor login password" value={contractorPassword} onChange={event=>setContractorPassword(event.target.value)} /></label>{contractorLoginError && <p role="alert">{contractorLoginError}</p>}<button type="submit">Log in</button></form></article></section>

    const label=kind==='subcontractor' ? 'Subcontractor Rates' : 'Contractor Rates'
    return <section className="summary-gallery rates-workspace" aria-label={label+' workspace'}><header className="summary-gallery-heading"><h2>{label}</h2>{kind==='contractor' && <button type="button" className="contractor-lock-button" onClick={lockContractorRates}>Lock Contractor Rates</button>}<p>All measured work · all drawings</p></header><article className="material-order-card"><h3>Work rates</h3>{measuredCategorySummaries.length ? <div className="material-table-wrap"><table className="quantity-table rates-table" aria-label={label+' table'}><colgroup><col className="quantity-col-work" /><col className="quantity-col-area" /><col className="quantity-col-length" /><col className="quantity-col-count" /><col className="quantity-col-rate" />{kind==='subcontractor' && <col className="quantity-col-value" />}</colgroup><thead><tr><th>Work description</th><th>m²</th><th>LM</th><th>Points</th><th>Rate</th>{kind==='subcontractor' && <th>Value</th>}</tr></thead><tbody>{measuredCategorySummaries.map(category=>{const price=workPrice(category);return <tr key={category.id}><th scope="row"><span className="category-swatch" style={{background:category.color}} />{quantityName(category)}</th>{quantityCells(category)}<td>{rateInput(kind,category)}</td>{kind==='subcontractor' && <td><strong>{price.value===null ? price.note : pounds(price.value)}</strong></td>}</tr>})}</tbody></table></div> : <p>Measure some work first. Only categories used in Plot Summary appear here.</p>}</article></section>
  }
  function simplifiedQuantityTable(rows:QuantityPriceRow[],label:string) {
    rows=orderedSummaryRows(rows)
    return rows.length ? <div className="material-table-wrap"><table className="quantity-table" aria-label={label}><colgroup><col className="quantity-col-work" /><col className="quantity-col-area" /><col className="quantity-col-length" /><col className="quantity-col-count" /><col className="quantity-col-rate" /><col className="quantity-col-value" /></colgroup><thead><tr><th>Work description</th><th>m²</th><th>LM</th><th>Points</th><th>Subcontractor rate</th><th>Value</th></tr></thead>{[...new Set(rows.map(summaryBlock))].flatMap((block,index)=>[...(index>0 ? [<tbody key={block+'-gap'} className="summary-trade-gap" aria-hidden="true"><tr><td colSpan={6} /></tr></tbody>] : []),<tbody key={block} className="summary-trade-box" data-summary-group={block}><tr data-summary-trade={block}><th colSpan={6}>{block}</th></tr>{rows.filter(row=>summaryBlock(row)===block).map(row=>{const price=workPrice(row);return <tr key={row.id} data-summary-item={row.id}><th scope="row">{quantityName(row)}</th>{quantityCells(row)}<td>{summaryRateText(row)}</td><td><strong>{price.value===null ? price.note : pounds(price.value)}</strong></td></tr>})}</tbody>])}</table></div> : <p>No measured work yet.</p>
  }
  function simplifiedSummary() {
    const ungrouped=pageDrawingSummaries.flatMap(page=>page.rows.filter(row=>row.id==='__ungrouped__'))
    const rows:QuantityPriceRow[]=[...measuredCategorySummaries,...(ungrouped.length ? [{id:'__ungrouped__',name:'Ungrouped Measurements',mode:'mixed',totalAreaM2:ungrouped.some(row=>row.totalAreaM2===null) ? null : ungrouped.reduce((sum,row)=>sum+(row.totalAreaM2 ?? 0),0),totalMm:ungrouped.some(row=>row.totalMm===null) ? null : ungrouped.reduce((sum,row)=>sum+(row.totalMm ?? 0),0),count:ungrouped.reduce((sum,row)=>sum+row.count,0)}] : [])]
    return <section className="summary-gallery simplified-summary-workspace plot-summary-gallery" aria-label="Simplified Plot Summary"><header className="summary-gallery-heading"><h2>Plot Summary · Simplified</h2><p>{[job.site,job.plot ? 'Plot '+job.plot : '',job.houseType,job.revision].filter(Boolean).join(' / ') || 'Job details not entered'}</p></header><article className="material-order-card"><h3>Whole plot · all drawings</h3>{simplifiedQuantityTable(rows,'Whole plot quantities')}{rows.length>0 && summaryTotals(rows,'whole plot')}</article>{pageDrawingSummaries.map(page=><article key={page.number} className="material-order-card"><h3>{page.name}</h3>{page.needsCalibration && <p className="quantity-table-warning">Calibrate and lock this drawing to show complete quantities.</p>}{simplifiedQuantityTable(page.rows,page.name+' quantities')}{page.rows.length>0 && summaryTotals(page.rows,page.name)}</article>)}<p className="length-note material-method-note">Values use subcontractor rates and the same rounding as Detailed view. Each scope totals its rounded category values. Skim reuses source areas and respects skim opt-outs.</p></section>
  }
  const plotPriceRows=measuredCategorySummaries.map(category=>({category,...workPrice(category)}))
  const plotPriceTotal=plotPriceRows.reduce((sum,row)=>sum+(row.value ?? 0),0)
  const unpricedCategories=plotPriceRows.filter(row=>row.value===null).length
  const selectedWork = currentPageGroupSummaries.find((group) => group.id === selectedWorkId)
  const showingAllWork = selectedWorkId === '__all__'
  const viewedWork = groupSummaries.find((group) => group.id === viewGroupId)

  function openMeasuredWork(id: string) {
    if (hasDraft || !groups.some((group) => group.id === id)) return
    showOnlyMeasuredWork(id)
    setSelectedWorkId(id)
  }

  function openAllMeasuredWork() {
    if (hasDraft) return
    showAllMeasurements()
    setSelectedWorkId('__all__')
    setSidebarTab('groups')
  }

  function showOnlyMeasuredWork(id: string) {
    setIsolatedMeasurementId(null)
    setOverviewDrawing(false)
    if (hasDraft || !groups.some((group) => group.id === id)) return
    setViewGroupId(id)
    setViewCategoryId('')
    setHiddenGroupIds([])
    setShowUngrouped(true)
    const members = groupSummaries.find((group) => group.id === id)?.members ?? []
    if (members.length && !members.some((item) => item.page === pageNumber)) {
      setPageNumber(members[0].page)
      setViewMode('fit-page')
      setPan({ x: 0, y: 0 })
    }
  }

  function showAllMeasurements() {
    setIsolatedMeasurementId(null)
    if (hasDraft) return
    selectViewCategory('')
    setOverviewDrawing(true)
    setSelectedWorkId('__all__')
    setSidebarTab('groups')
  }
  const currentCounts = countMeasurements[pageNumber] ?? []
  const viewSummary = viewedWork ? { ...viewedWork, mode: categories.find((category) => category.id === viewedWork.categoryId)?.mode ?? 'measure' }
    : categorySummaries.find((category) => category.id === viewCategoryId)
  function withQuantities(item: (typeof allMeasurements)[number]) {
    const calibration = calibrations[item.page]
    const valid = !!calibration && calibration.locked && !calibration.needsRecalibration
    const lengthMm = valid ? item.pdfLength * calibration.mmPerPdfUnit : null
    const invalidHeight = heightDrafts[item.id] !== undefined && heightDrafts[item.id] !== ''
      && (!Number.isFinite(Number(heightDrafts[item.id])) || Number(heightDrafts[item.id]) <= 0)
    const areaM2 = !valid || invalidHeight ? null : item.kind === 'area' ? item.pdfArea * calibration.mmPerPdfUnit ** 2 / 1000000
      : item.heightM !== undefined ? wallAreaFromLength(item.pdfLength*calibration.mmPerPdfUnit,item.heightM,!!item.doorHead) : null
    return { ...item, lengthMm, areaM2 }
  }
  const viewItems = allMeasurements.filter((item) => matchesViewCategory(item.groupId, item.categoryId, item.kind === 'wall', item.heightM)).map(withQuantities)
  const selectedWorkItems = allMeasurements.filter((item) => item.groupId === selectedWorkId && item.page === pageNumber).map(withQuantities)
  const ungroupedItems = allMeasurements.filter((item) => !item.groupId && item.page===pageNumber).map(withQuantities)
  const ungroupedGeometry = ungroupedItems.filter((item) => item.kind !== 'count')
  const workOverviewRows = [
    ...currentPageGroupSummaries.map((group) => ({ id: group.id, name: group.name || group.id,
      mode: categories.find((category) => category.id === group.categoryId)?.mode ?? 'measure',
      totalMm: group.totalMm, totalAreaM2: group.totalAreaM2, count: group.count, colors: [categoryColor(group.id, '#64748b')], sourceNote: '' })),
    ...(ungroupedItems.length ? [{ id: '__ungrouped__', name: 'Ungrouped Measurements', mode: 'mixed', sourceNote: '', colors: [...new Set(ungroupedItems.map((item) => item.kind === 'count' ? categories.find((category) => category.id === item.categoryId)?.color ?? '#dc2626' : item.kind === 'area' ? '#c2410c' : item.id.startsWith('R') ? '#0f766e' : '#2563eb'))],
      totalMm: ungroupedGeometry.some((item) => item.lengthMm === null) ? null : ungroupedGeometry.reduce((sum, item) => sum + (item.lengthMm ?? 0), 0),
      totalAreaM2: ungroupedGeometry.some((item) => item.kind === 'area' || item.heightM !== undefined ? item.areaM2 === null : false) ? null
        : ungroupedGeometry.reduce((sum, item) => sum + (item.areaM2 ?? 0), 0),
      count: ungroupedItems.filter((item) => item.kind === 'count').length }] : []),
    ...summarizeCategories(currentPageGroupSummaries,pageNumber).filter((category) => category.mode === 'derived' && category.sourceGroups.some(group=>group.members.some(item=>item.kind==='area' || item.heightM!==undefined))).map((category) => ({
      id: category.id, name: category.name, mode: 'derived', totalMm: 0, totalAreaM2: category.totalAreaM2, count: 0,
      colors: [...new Set(category.sourceGroups.filter((group) => group.members.some((item) => item.kind === 'area' || item.heightM !== undefined)).map((group) => categoryColor(group.id, category.color)))],
      sourceNote: 'N.B. Calculated from ' + category.sourceGroups.filter((group) => group.members.some((item) => item.kind === 'area' || item.heightM !== undefined)).map((group) => (group.name || group.id) + ' (' + (categories.find((item) => item.id === group.categoryId)?.name ?? 'Uncategorised') + ')').join(', ') + '. Uses those measured areas; no additional drawing measurement. Groups opted out of skim are excluded.'
    })),

  ]
  function isInsulationArea(groupId?:string) {const category=categories.find(category=>category.id===groups.find(group=>group.id===groupId)?.categoryId);return !!category && categoryWorkHeading(category)==='Insulation'}
  function summaryColorFor(groupId: string | undefined, fallback: string) {
    const group = groups.find((item) => item.id === groupId)
    return group?.appearance?.color ?? categories.find((item) => item.id === group?.categoryId)?.color ?? fallback
  }

  function drawingSummary(number: number) {
    const members = allMeasurements.filter((item) => item.page === number)
    const work = groups.map((group) => summarizeWork(group, members.filter((item) => item.groupId === group.id))).filter((group) => group.members.length)
    const categoriesOnPage = summarizeCategories(work, number).filter((category) => category.mode === 'count' ? category.count > 0
      : category.sourceGroups.some((group) => group.members.some((item) => category.mode !== 'derived' || item.kind === 'area' || (item.kind === 'wall' && item.heightM !== undefined))))
    const rows = categoriesOnPage.map((category) => ({
      id: category.id, name: category.name, mode: category.mode as string, totalMm: category.totalMm, totalAreaM2: category.totalAreaM2, count: category.count,
      colors: [...new Set(category.sourceGroups.map((group) => summaryColorFor(group.id,category.color)))].length ? [...new Set(category.sourceGroups.map((group) => summaryColorFor(group.id,category.color)))] : [category.color],
      sourceNote: category.mode === 'derived' ? 'N.B. Reuses measured areas from ' + category.sourceGroups.filter((group) => group.members.some((item) => item.kind === 'area' || item.heightM !== undefined)).map((group) => group.name || group.id).join(', ') + ' on this drawing. No extra measurement is added; skim opt-outs are respected.' : '',
      wallsWithoutHeight: category.wallsWithoutHeight,
    }))
    const ungrouped = members.filter((item) => !item.groupId && item.kind !== 'count').map(withQuantities)
    const geometry = ungrouped.filter((item) => item.kind !== 'count')
    if (ungrouped.length) rows.push({ id:'__ungrouped__', name:'Ungrouped Measurements', mode:'mixed',
      totalMm:geometry.some((item) => item.lengthMm === null) ? null : geometry.reduce((sum,item) => sum+(item.doorHead ? 0 : item.lengthMm ?? 0),0),
      totalAreaM2:geometry.some((item) => (item.kind === 'area' || item.heightM !== undefined) && item.areaM2 === null) ? null : geometry.reduce((sum,item) => sum+(item.areaM2 ?? 0),0),
      count:0, colors:[...new Set(ungrouped.map((item) => item.kind === 'area' ? '#c2410c' : item.id.startsWith('R') ? '#0f766e' : '#2563eb'))], sourceNote:'Not assigned to a work category.', wallsWithoutHeight:geometry.filter((item) => item.kind === 'wall' && item.heightM === undefined).length })
    const calibration=calibrations[number]
    return { number, name:drawingPageName(number), rows:orderedSummaryRows(rows), measurementCount:members.length,
      needsCalibration:members.some((item) => item.kind !== 'count') && (!calibration || !calibration.locked || calibration.needsRecalibration) }
  }
  const orderedPlotCategories=orderedSummaryRows(measuredCategorySummaries)
  const pageDrawingSummaries = sidebarTab === 'summary' ? drawingPages.map((_,index) => drawingSummary(index+1)) : []

  async function prepareSummaryPage(number: number, page: any) {
    const document=pdf
    if (!document) return
    if (pdfSnapCache.current.doc !== document) pdfSnapCache.current={doc:document,pages:new Map()}
    if (pdfSnapCache.current.pages.has(number)) return
    try {
      const operators=await page.getOperatorList()
      if (pdfSnapCache.current.doc === document && !pdfSnapCache.current.pages.has(number)) pdfSnapCache.current.pages.set(number,makeSnapIndex(pdfLineSegments(operators,pdfjsLib.OPS),'PDF'))
    } catch { /* Preview rendering can continue when PDF line detection is unavailable. */ }
  }

  const calibrationAttention = !!pdf && !currentCalibration && !calibrationMode && !pendingCalibration
  const renderedCounts = currentCounts.filter((item) => (!isolatedMeasurementId || item.id===isolatedMeasurementId) && isMeasurementVisible(item.groupId, countCategoryId(item))).map((item) => {
    const [x, y] = viewportRef.current?.convertToViewportPoint(item.point.x, item.point.y) ?? [0, 0]
    return { ...item, x, y, color: categoryColor(item.groupId, categories.find((category) => category.id === countCategoryId(item))?.color ?? '#dc2626') }
  })
  const currentAreas = areaMeasurements[pageNumber] ?? []
  const draftAreaProblem = polygonProblem(areaPoints)
  const draftAreaM2 = lengthCalibrationValid && !draftAreaProblem
    ? polygonArea(areaPoints) * currentCalibration.mmPerPdfUnit ** 2 / 1000000 : null
  const renderedAreas = [...currentAreas.filter((area) => (!isolatedMeasurementId || area.id===isolatedMeasurementId) && isMeasurementVisible(area.groupId)), ...(areaMode ? [{ id: 'Draft area', points: areaPoints, locked: true, groupId: activeGroupId || undefined }] : [])].map((area) => ({
    ...area,
    color: categoryColor(area.groupId, '#c2410c'),
    handles: area.points.map((point) => {
      const [x, y] = viewportRef.current?.convertToViewportPoint(point.x, point.y) ?? [0, 0]
      return { x, y }
    }),
    areaM2: lengthCalibrationValid ? polygonArea(area.points) * currentCalibration.mmPerPdfUnit ** 2 / 1000000 : null,
  }))
  const draftSegments = runSegments(runPoints)
  const draftTotalMm = draftSegments.reduce((sum, mm) => sum + mm, 0)
  const renderedRuns = [
    ...currentRuns.filter((run) => (!isolatedMeasurementId || run.id===isolatedMeasurementId) && isMeasurementVisible(run.groupId, undefined, true, run.heightM)),
    ...(runMode ? [{ id: 'Draft', points: runPoints, locked: true, groupId: activeGroupId || undefined }] : []),
  ].map((run) => ({
    ...run,
    color: categoryColor(run.groupId, '#0f766e'),
    handles: run.points.map((point) => {
      const [x, y] = viewportRef.current?.convertToViewportPoint(point.x, point.y) ?? [0, 0]
      return { x, y }
    }),
    segments: runSegments(run.points),
  }))

  const renderedLengths = currentLengthMeasurements.map((measurement) => {
    let line:
      | { x1: number; y1: number; x2: number; y2: number }
      | null = null
    let pointAHandle: { x: number; y: number } | null = null
    let pointBHandle: { x: number; y: number } | null = null

    if (viewportRef.current) {
      const [x1, y1] = viewportRef.current.convertToViewportPoint(
        measurement.pointA.x,
        measurement.pointA.y
      )
      const [x2, y2] = viewportRef.current.convertToViewportPoint(
        measurement.pointB.x,
        measurement.pointB.y
      )

      line = { x1, y1, x2, y2 }
      pointAHandle = { x: x1, y: y1 }
      pointBHandle = { x: x2, y: y2 }
    }

    let lengthMm: number | null = null

    if (lengthCalibrationValid && currentCalibration) {
      const dx = measurement.pointB.x - measurement.pointA.x
      const dy = measurement.pointB.y - measurement.pointA.y
      const pdfDistance = Math.sqrt(dx * dx + dy * dy)
      lengthMm = pdfDistance * currentCalibration.mmPerPdfUnit
    }

    return {
      ...measurement,
      visible: (!isolatedMeasurementId || measurement.id===isolatedMeasurementId) && isMeasurementVisible(measurement.groupId, undefined, true, measurement.heightM),
      color: categoryColor(measurement.groupId, '#2563eb'),
      line,
      pointAHandle,
      pointBHandle,
      lengthMm,
    }
  })

  let temporaryLengthAHandle: { x: number; y: number } | null = null

  if (lengthPoints.length === 1 && viewportRef.current) {
    const [x, y] = viewportRef.current.convertToViewportPoint(
      lengthPoints[0].x,
      lengthPoints[0].y
    )
    temporaryLengthAHandle = { x, y }
  }

  function workLockState(id: string, scopePage?: number): 'locked' | 'unlocked' | 'mixed' | 'empty' {
    const members: Array<{locked:boolean}> = []
    for (const record of [lengthMeasurements,runMeasurements,areaMeasurements,countMeasurements]) for (const [page,items] of Object.entries(record)) if (scopePage === undefined || Number(page) === scopePage) members.push(...items.filter((item: {groupId?:string;locked:boolean}) => item.groupId === id))
    if (!members.length) return 'empty'
    return members.every((item) => item.locked) ? 'locked' : members.every((item) => !item.locked) ? 'unlocked' : 'mixed'
  }

  function setWorkLocked(id: string, locked: boolean, scopePage?: number) {
    const change = <T extends { groupId?: string; locked: boolean },>(record: Record<number, T[]>) =>
      Object.fromEntries(Object.entries(record).map(([page, items]) => [page, items.map((item) => item.groupId === id && (scopePage === undefined || Number(page) === scopePage) ? { ...item, locked } : item)]))
    setLengthMeasurements(change); setRunMeasurements(change); setAreaMeasurements(change); setCountMeasurements(change)
    setStatus(`${groups.find((group) => group.id === id)?.name || id}: measurements ${locked ? 'locked' : 'unlocked'} ${scopePage === undefined ? 'across all drawings' : 'on ' + drawingPageName(scopePage)}.`)
  }

  function openWorkMenu(event: React.MouseEvent<HTMLElement>, groupId: string, scopePage?: number) {
    event.preventDefault(); event.stopPropagation()
    stopMeasurement()
    setMeasurementMenu(null)
    const bounds = workspaceRef.current?.getBoundingClientRect()
    setWorkMenu({ groupId, scopePage, x: Math.max(8, Math.min(event.clientX - (bounds?.left ?? 0), (bounds?.width ?? 1000) - 228)), y: Math.max(8, Math.min(event.clientY - (bounds?.top ?? 0), (bounds?.height ?? 700) - 230)) })
  }

  function workMenuAction(action: 'edit' | 'lock' | 'delete') {
    if (!workMenu) return
    const { groupId, scopePage } = workMenu
    const group = groups.find((item) => item.id === groupId)
    if (!group) { setWorkMenu(null); return }
    if (action === 'delete') {
      const members = allMeasurements.filter((item) => item.groupId === groupId && (scopePage === undefined || item.page === scopePage))
      if (!window.confirm(`Delete "${group.name || group.id}" and its ${members.length} measurements ${scopePage === undefined ? 'across all pages' : 'on ' + drawingPageName(scopePage) + ' only'}?`)) { setWorkMenu(null); return }
      const remove = <T extends { groupId?: string },>(record: Record<number, T[]>) => Object.fromEntries(Object.entries(record).map(([page, items]) => [page, items.filter((item) => item.groupId !== groupId || (scopePage !== undefined && Number(page) !== scopePage))]))
      setLengthMeasurements(remove); setRunMeasurements(remove); setAreaMeasurements(remove); setCountMeasurements(remove)
      const removeGroupToo = !allMeasurements.some((item) => item.groupId === groupId && scopePage !== undefined && item.page !== scopePage)
      if (removeGroupToo) setGroups((current) => current.filter((item) => item.id !== groupId))
      setHeightDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !members.some((item) => item.id === id))))
      setGroupHeightDrafts((current) => { const next = { ...current }; for (const key of Object.keys(next)) if (removeGroupToo ? key === groupId || key.startsWith(groupId + ':') : key === groupId + ':' + scopePage) delete next[key]; return next })
      if (removeGroupToo) setHiddenGroupIds((current) => current.filter((id) => id !== groupId))
      if (removeGroupToo && activeGroupId === groupId) setActiveGroupId('')
      if (viewGroupId === groupId) setViewGroupId('')
      if (selectedWorkId === groupId) setSelectedWorkId(null)
      setStatus(`${group.name || group.id} and its measurements deleted.`)
    } else if (action === 'lock') setWorkLocked(groupId, workLockState(groupId,scopePage) !== 'locked', scopePage)
    else {
      const members = allMeasurements.filter((item) => item.groupId === groupId && (scopePage === undefined || item.page === scopePage))
      setWorkLocked(groupId, false, scopePage)
      setSidebarTab('measure')
      setSelectedWorkId(groupId)
      setViewGroupId(groupId); setViewCategoryId(''); setHiddenGroupIds([]); setShowUngrouped(true); setOverviewDrawing(false)
      if (members.length && !members.some((item) => item.page === pageNumber)) {
        setPageNumber(members[0].page); setViewMode('fit-page'); setPan({ x: 0, y: 0 })
      }
      setStatus(`${group.name || group.id}: points unlocked ${scopePage === undefined ? 'on all pages' : 'on ' + drawingPageName(scopePage)}. Drag individual points on the displayed page; use the padlock to lock them again.`)
    }
    setWorkMenu(null)
  }


  function measurementAt(clientX:number,clientY:number) {
    const drawing = drawingRef.current
    if (!drawing) return null
    const rect = drawing.getBoundingClientRect(), x = clientX - rect.left, y = clientY - rect.top
    let best: { id: string; kind: MeasurementKind } | null = null, bestDistance = Infinity
    const distance = (a: Point, b: Point) => {
      const dx=b.x-a.x, dy=b.y-a.y, size=dx*dx+dy*dy
      const t=size ? Math.max(0,Math.min(1,((x-a.x)*dx+(y-a.y)*dy)/size)) : 0
      return Math.hypot(x-a.x-t*dx,y-a.y-t*dy)
    }
    const consider = (id: string, kind: MeasurementKind, points: Point[], groupId?: string, closed = false) => {
      if (id.startsWith('Draft') || !points.length) return
      let d=Infinity
      for (let i=1; i<points.length; i++) d=Math.min(d,distance(points[i-1],points[i]))
      if (closed) d=Math.min(d,distance(points[points.length-1],points[0]))
      if (d <= Math.max(10,measurementAppearance(groupId).width/2+6) && d < bestDistance) { bestDistance=d; best={ id, kind } }
    }
    for (const item of renderedLengths) if (item.visible && item.line) consider(item.id,'length',[{x:item.line.x1,y:item.line.y1},{x:item.line.x2,y:item.line.y2}],item.groupId)
    for (const item of renderedRuns) consider(item.id,'run',item.handles,item.groupId)
    for (const item of renderedAreas) consider(item.id,'area',item.handles,item.groupId,true)
    for (const item of renderedCounts) {
      const d=Math.hypot(x-item.x,y-item.y)
      if (d<=14 && d<bestDistance) { bestDistance=d; best={id:item.id,kind:'point'} }
    }
    return best as {id:string;kind:MeasurementKind}|null
  }
  function updateMeasurementHover(event: React.PointerEvent<HTMLElement>) {
    setHoveredMeasurementId(!isPanning && !currentToolKind() && !calibrationMode && !pendingCalibration ? measurementAt(event.clientX,event.clientY)?.id ?? null : null)
  }
  useEffect(()=>{setHoveredMeasurementId(null)},[pageNumber,sidebarTab,scale,rotation,isolatedMeasurementId,viewGroupId,viewCategoryId])
  function openMeasurementMenu(event: React.MouseEvent<HTMLElement>) {
    const best=measurementAt(event.clientX,event.clientY)
    if (!best) { setMeasurementMenu(null); return }
    setWorkMenu(null)
    event.preventDefault(); event.stopPropagation()
    const bounds=workspaceRef.current?.getBoundingClientRect()
    setMeasurementMenu({ ...best, x:Math.max(8,Math.min(event.clientX-(bounds?.left ?? 0),(bounds?.width ?? 1000)-228)), y:Math.max(8,Math.min(event.clientY-(bounds?.top ?? 0),(bounds?.height ?? 700)-240)) })
  }

  const contextItem = measurementMenu ? measurementMenu.kind === 'length' ? currentLengthMeasurements.find((item) => item.id === measurementMenu.id)
    : measurementMenu.kind === 'run' ? currentRuns.find((item) => item.id === measurementMenu.id)
    : measurementMenu.kind === 'area' ? currentAreas.find((item) => item.id === measurementMenu.id)
    : currentCounts.find((item) => item.id === measurementMenu.id) : undefined

  function isSelectedPoint(id: string,index: number) { return selectedEditPoint?.page===pageNumber && selectedEditPoint.id===id && selectedEditPoint.index===index }
  function deleteSelectedPoint(selection=selectedEditPoint) {
    if (!selection || selection.page!==pageNumber || hasDraft) return
    const {id,kind,index}=selection
    const item=kind==='run' ? currentRuns.find(i=>i.id===id) : kind==='area' ? currentAreas.find(i=>i.id===id) : kind==='length' ? currentLengthMeasurements.find(i=>i.id===id) : currentCounts.find(i=>i.id===id)
    if (!item || item.locked) return
    if (kind==='length') {setStatus('A single length needs both endpoints. Choose Delete Entire Run/Measure instead.');return}
    if (kind==='point') deleteCount(id)
    else {
      if (!hasValidCalibration() || !('points' in item) || index<0 || index>=item.points.length) return
      const points=item.points.filter((_,i)=>i!==index)
      const problem=kind==='area' ? polygonProblem(points) : points.length<2 ? 'A run needs at least two points.' : points.some((p,i)=>i>0 && Math.hypot(p.x-points[i-1].x,p.y-points[i-1].y)<0.001) ? 'These points would create a zero-length segment.' : null
      if (problem) {setStatus(problem+' Delete the entire measurement if needed.');return}
      if (kind==='area') setAreaMeasurements(current=>({...current,[pageNumber]:(current[pageNumber] ?? []).map(i=>i.id===id ? {...i,points} : i)}))
      else setRunMeasurements(current=>({...current,[pageNumber]:(current[pageNumber] ?? []).map(i=>i.id===id ? {...i,points} : i)}))
    }
    runDragRef.current=null;areaDragRef.current=null;countDragRef.current=null
    setSelectedEditPoint(null);setMeasurementMenu(null);setStatus('Selected point deleted. Quantities updated.')
  }
  function openPointMenu(event: React.MouseEvent<SVGElement>,id: string,kind: MeasurementKind,index: number) {
    event.preventDefault();event.stopPropagation()
    if (hasDraft) return
    setSelectedEditPoint({id,kind,index,page:pageNumber});setWorkMenu(null)
    const bounds=workspaceRef.current?.getBoundingClientRect()
    setMeasurementMenu({id,kind,pointIndex:index,x:Math.max(8,Math.min(event.clientX-(bounds?.left ?? 0),(bounds?.width ?? 1000)-228)),y:Math.max(8,Math.min(event.clientY-(bounds?.top ?? 0),(bounds?.height ?? 700)-270))})
  }
  useEffect(()=>{
    const down=(event: KeyboardEvent)=>{if(event.key==='Shift') shiftHeldRef.current=true}
    const up=(event: KeyboardEvent)=>{if(event.key==='Shift') shiftHeldRef.current=false}
    const blur=()=>{shiftHeldRef.current=false}
    window.addEventListener('keydown',down);window.addEventListener('keyup',up);window.addEventListener('blur',blur)
    return ()=>{window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);window.removeEventListener('blur',blur)}
  },[])
  useEffect(()=>{
    const remove=(event: KeyboardEvent)=>{
      const target=event.target as HTMLElement | null
      if(event.key!=='Delete' || event.repeat || !selectedEditPoint || target?.closest('input,textarea,select,button,[contenteditable="true"]')) return
      event.preventDefault();deleteSelectedPoint()
    }
    window.addEventListener('keydown',remove);return ()=>window.removeEventListener('keydown',remove)
  },[selectedEditPoint,pageNumber,hasDraft,currentRuns,currentAreas,currentCounts,currentLengthMeasurements,lengthCalibrationValid])
  useEffect(()=>{setSelectedEditPoint(null);setPageDeletePrompt(null)},[pdf,pageNumber])
  useEffect(()=>{
    if(!pageDeletePrompt) return
    const close=()=>setPageDeletePrompt(null)
    const outside=(event: PointerEvent)=>{if(!(event.target as Element | null)?.closest('[data-page-delete-prompt]')) close()}
    const escape=(event: KeyboardEvent)=>{if(event.key==='Escape') close()}
    window.addEventListener('pointerdown',outside);window.addEventListener('keydown',escape);window.addEventListener('resize',close);window.addEventListener('scroll',close,true)
    return ()=>{window.removeEventListener('pointerdown',outside);window.removeEventListener('keydown',escape);window.removeEventListener('resize',close);window.removeEventListener('scroll',close,true)}
  },[pageDeletePrompt])

  function measurementMenuAction(action: 'edit' | 'lock' | 'delete' | 'delete-point') {
    if (!measurementMenu || !contextItem) return
    if (hasDraft) { setStatus('Finish or cancel the current measurement before editing a saved one.'); return }
    const { id, kind } = measurementMenu
    if (action==='delete-point') {deleteSelectedPoint({id,kind,index:measurementMenu.pointIndex ?? 0,page:pageNumber});return}
    setSelectedEditPoint(null)
    if (action === 'edit' && kind !== 'point' && !hasValidCalibration()) { setStatus('Calibrate and lock this page before editing measurement points.'); return }
    setReadyToolKind(null)
    setOverviewDrawing(false)
    setSnapPreview(null)
    if (action === 'delete') {
      if (kind === 'length') deleteLengthMeasurement(id)
      else if (kind === 'run') deleteRun(id)
      else if (kind === 'area') deleteArea(id)
      else deleteCount(id)
    } else {
      if (action === 'lock' || contextItem.locked) {
        if (kind === 'length') toggleLengthLock(id)
        else if (kind === 'run') toggleRunLock(id)
        else if (kind === 'area') toggleAreaLock(id)
        else toggleCountLock(id)
      }
      setStatus(action === 'edit' ? `${id} ready to edit. Drag its points, then right-click and choose Lock when finished.` : `${id} ${contextItem.locked ? 'unlocked' : 'locked'}.`)
    }
    setMeasurementMenu(null)
    stageRef.current?.focus({ preventScroll: true })
  }

  useEffect(() => {
    if (!measurementMenu && !workMenu) return
    const close = () => { setMeasurementMenu(null); setWorkMenu(null) }
    const outside = (event: PointerEvent) => { if (!(event.target as Element | null)?.closest('[data-measurement-menu], [data-work-menu]')) close() }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('pointerdown',outside)
    window.addEventListener('keydown',escape)
    window.addEventListener('resize',close)
    return () => { window.removeEventListener('pointerdown',outside); window.removeEventListener('keydown',escape); window.removeEventListener('resize',close) }
  }, [measurementMenu, workMenu])
  useEffect(() => { setMeasurementMenu(null) }, [pdf,pageNumber,scale,rotation,pan])


  const zoomPercent = Math.max(25, Math.min(1500, Math.round(scale * 100)))

  return (
    <div className={`app-shell${tabletLandscape ? ' ipad-landscape' : ''}`} style={{'--measure-bar-height':toolbarBarHeight+'px'} as React.CSSProperties} aria-busy={isFileBusy}>
      <header ref={toolbarHeaderRef} className="topbar" inert={isFileBusy || !!measurementChooser || heightPromptOpen || !!duplicateRequest || newDescriptionOpen}>
        <div className="brand-and-project">
          <div className="takeoff-brand">
            <svg className="brand-mark" viewBox="0 0 34 38" aria-hidden="true"><path fill="#21d4ce" d="M17 1 32 9 17 18 2 10z" /><path fill="#00a8a4" d="m2 13 12 7v14L2 27z" /><path fill="#19d1c7" d="m19 20 13-8v15l-13 9z" /><path fill="#6ce8df" d="m8 17 7 4-7 12z" /></svg>
            <span>Holmes QS</span>
          </div>
          <button className="project-menu-button" aria-expanded={jobPanelOpen} aria-controls="job-details-panel" onClick={() => setJobPanelOpen((open) => !open)} title={fileName || 'Job details'}>
            <span>{[job.site, job.plot ? 'Plot ' + job.plot : '', job.houseType].filter(Boolean).join(' / ') || 'Job details'}</span><span aria-hidden="true">⌄</span>
          </button>
          <span className={`header-save-state ${hasUnsavedChanges ? 'is-unsaved' : ''}`}>
            <span className="save-state-dot" />{isFileBusy ? 'Opening…' : hasUnsavedChanges ? 'Unsaved changes' : pdf ? 'Measure saved' : 'Ready to start'}
          </span>
        </div>

        <nav className="top-navigation" aria-label="Workspace sections">
          <button aria-pressed={sidebarTab === 'measure'} onClick={() => navigateWorkspace('measure')}><UiIcon name="file" />Drawings</button>
          <button aria-pressed={sidebarTab === 'groups'} onClick={() => navigateWorkspace('groups')}><UiIcon name="work" />Measured Work</button>
          <button aria-pressed={sidebarTab === 'contractor-rates'} onClick={() => navigateWorkspace('contractor-rates')}><UiIcon name="summary" />Contractor Rates</button>
          <button aria-pressed={sidebarTab === 'rates'} onClick={() => navigateWorkspace('rates')}><UiIcon name="summary" />Subcontractor Rates</button>
          <button aria-pressed={sidebarTab === 'summary'} onClick={() => navigateWorkspace('summary')}><UiIcon name="summary" />Plot Summary</button>
          <button aria-pressed={sidebarTab === 'materials'} onClick={() => navigateWorkspace('materials')}><UiIcon name="work" />Materials</button>
          <button aria-pressed={sidebarTab === 'export'} onClick={() => navigateWorkspace('export')}><UiIcon name="file" />Export</button>
          {tabletLandscape && <button className="tablet-controls-toggle" aria-expanded={tabletSidebarOpen} aria-controls="workspace-controls" onClick={()=>setTabletSidebarOpen(open=>!open)}>{tabletSidebarOpen ? 'Hide controls' : 'Show controls'}</button>}
        </nav>
        <div className="file-actions">
          <button className="save-takeoff-button" disabled={!pdf || isFileBusy || hasDraft || hasInvalidHeight}
            title={hasDraft ? 'Finish or cancel your current measurement or calibration first' : 'Download the PDF, job details and measurements together'}
            onClick={saveTakeoff}><UiIcon name="save" />Save Measure</button>
          <label className={`upload-button open-takeoff-button ${isFileBusy ? 'file-disabled' : ''}`}>
            <UiIcon name="file" />Open Measure
            <input type="file" accept=".json,.takeoff.json,application/json" disabled={isFileBusy}
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void openTakeoff(file)
              }} />
          </label>
        <label className={`upload-button ${isFileBusy ? 'file-disabled' : ''}`}>
          <UiIcon name="import" />Import New Drawing

          <input
            type="file"
            accept="application/pdf"
            disabled={isFileBusy}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''

              if (file) {
                openPdf(file)
              }
            }}
          />
        </label>
        </div>
        <section id="job-details-panel" hidden={!jobPanelOpen} className="banner-job" aria-label="Job details" onKeyDown={(event) => { if (event.key === 'Escape') setJobPanelOpen(false) }}>
          <div className="job-panel-heading"><strong>Job details</strong><button aria-label="Close job details" onClick={() => setJobPanelOpen(false)}>×</button></div>

          <label>
            Site
            <input disabled={isFileBusy} placeholder="e.g. Oak Meadow" value={job.site} onChange={(event) => setJob((current) => ({ ...current, site: event.target.value }))} />
          </label>

          <label>
            Plot
            <input disabled={isFileBusy} placeholder="e.g. 23" value={job.plot} onChange={(event) => setJob((current) => ({ ...current, plot: event.target.value }))} />
          </label>

          <label>
            House type
            <input disabled={isFileBusy} placeholder="e.g. Warwick" value={job.houseType} onChange={(event) => setJob((current) => ({ ...current, houseType: event.target.value }))} />
          </label>

          <label>
            Drawing revision
            <input disabled={isFileBusy} placeholder="e.g. Rev B" value={job.revision} onChange={(event) => setJob((current) => ({ ...current, revision: event.target.value }))} />
          </label>



</section>
      </header>

      <main ref={workspaceRef} className={`workspace${tabletLandscape && !tabletSidebarOpen ? ' tablet-controls-hidden' : ''}  ${sidebarTab === 'summary' || sidebarTab === 'materials' || sidebarTab === 'export' || sidebarTab === 'rates' || sidebarTab === 'contractor-rates' ? 'is-summary' : ''} ${selectedWork || showingAllWork ? 'has-work-details' : ''}`} inert={isFileBusy || !!measurementChooser || heightPromptOpen || !!duplicateRequest || newDescriptionOpen}>
        <aside className="sidebar" id="workspace-controls">
          <div className="sidebar-fixed">
          <nav className="sidebar-tabs" aria-label="Take-off sections">
            {(['measure', 'groups', 'summary'] as const).map((tab) => <button key={tab}
              aria-pressed={sidebarTab === tab} onClick={() => { navigateWorkspace(tab); if (tab === 'measure') setToolboxOpen(true) }}>
              <UiIcon name={tab === 'measure' ? 'length' : tab === 'groups' ? 'work' : 'summary'} />
              <span>{tab === 'measure' ? 'New Measure' : tab === 'groups' ? 'Measured Work' : 'Plot Summary'}</span>
            </button>)}
          </nav>
          <section ref={calibrationDockRef} className={`calibration-dock ${!pdf ? 'calibration-empty' : lengthCalibrationValid ? 'calibration-ready' : 'calibration-not-ready'}`} aria-label="Page calibration">
            <div className="calibration-readiness" role="status">
              <span aria-hidden="true">{!pdf ? '○' : lengthCalibrationValid ? '✓' : '✕'}</span>
              <div><strong>{!pdf ? 'Import a drawing to begin' : lengthCalibrationValid ? 'Set up and ready' : 'Calibration required'}</strong>
                <div>{!pdf ? 'Use Import New Drawing above.' : lengthCalibrationValid ? `Page ${pageNumber} calibrated and locked.` : calibrationIssue === 'unlocked' ? 'Calibration is unlocked. Lock it before measuring.' : calibrationIssue === 'changed' ? 'Calibration points changed. Recalibrate before measuring.' : `Page ${pageNumber} needs calibration before measuring.`}</div>
              </div>
            </div>
            <div className="calibration-dock-tools">
              {currentCalibration && <div className="calibration-icon-actions">
                <button type="button" aria-label={currentCalibration.locked ? 'Unlock calibration' : 'Lock calibration'} title={currentCalibration.locked ? 'Unlock calibration' : 'Lock calibration'} disabled={hasDraft || !!currentCalibration.needsRecalibration} onClick={()=>{setCalibrationVisible(true);currentCalibration.locked ? unlockCalibration() : lockCalibration()}}><UiIcon name={currentCalibration.locked ? 'lock' : 'unlock'} /></button>
                <button type="button" className="clear-calibration-icon" aria-label="Clear calibration" title="Clear calibration" disabled={hasDraft} onClick={()=>{if(window.confirm('Clear calibration for this drawing? Its measurements will need calibration again.'))clearCalibration()}}>✕</button>
                <button type="button" aria-label={calibrationVisible ? 'Hide calibration' : 'Show calibration'} title={calibrationVisible ? 'Hide calibration' : 'Show calibration'} aria-pressed={calibrationVisible} onClick={()=>setCalibrationVisible(value=>!value)}><UiIcon name={calibrationVisible ? 'eye' : 'eye-off'} /></button>
              </div>}
          {!lengthCalibrationValid && pdf && <p className="calibration-first-note">
            {!currentCalibration ? 'Calibrate your drawing to enable measurement tools.' : currentCalibration.needsRecalibration ? 'Update the calibration below to enable measurement tools.' : 'Lock the calibration below to enable measurement tools.'}
          </p>}
          <button
            hidden={!!currentCalibration?.locked && !currentCalibration.needsRecalibration && !calibrationMode}
            className={`future-tool ${calibrationAttention ? 'calibrate-attention' : ''}`}
            disabled={!pdf || runMode || areaMode || countMode}
            onClick={()=>{setCalibrationVisible(true);calibrationMode ? cancelCalibration() : startCalibration()}}
          >
            {calibrationMode ? 'Cancel Calibration' : calibrationAttention ? 'Calibrate Drawing' : 'Calibrate'}
          </button>

          {pendingCalibration && (
            <div className="calibration-panel">
              <label>
                Known distance (mm)
                <input
                  autoFocus
                  type="number"
                  min="1"
                  step="1"
                  value={calibrationDistance}
                  onChange={(event) => setCalibrationDistance(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      saveCalibration()
                    }
                  }}
                  placeholder="e.g. 3600"
                />
              </label>

              <button onClick={saveCalibration}>
                Save Calibration
              </button>
            </div>
          )}

          {currentCalibration && (
            <div
              hidden={currentCalibration.locked && !currentCalibration.needsRecalibration}
              className={`calibration-panel ${
                currentCalibration.needsRecalibration || !currentCalibration.locked
                  ? 'needs-recalibration'
                  : 'calibrated'
              }`}
            >
              <strong>
                {currentCalibration.needsRecalibration
                  ? '⚠ Recalibration required'
                  : currentCalibration.locked
                  ? '✓ Page calibrated · Locked'
                  : 'Calibration unlocked'}
              </strong>

              <div>
                Known distance: {currentCalibration.distanceMm.toLocaleString()} mm
              </div>

              {currentCalibration.needsRecalibration ? (
                <>
                  <div className="calibration-warning">
                    A calibration point has moved. Enter the known distance for
                    the points in their new positions before taking measurements.
                  </div>

                  <label>
                    New known distance (mm)
                    <input
                      autoFocus
                      type="number"
                      min="1"
                      step="1"
                      value={recalibrationDistance}
                      onChange={(event) =>
                        setRecalibrationDistance(event.target.value)
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          recalibrateCurrentPoints()
                        }
                      }}
                      placeholder="e.g. 3600"
                    />
                  </label>

                  <button onClick={recalibrateCurrentPoints}>
                    Recalibrate & Lock
                  </button>
                </>
              ) : !currentCalibration.locked ? <div className="calibration-note">Drag point A or B to fine-tune its position, then lock calibration.</div> : null}

            </div>
          )}


            </div>
          </section>
          </div>
          <div className="sidebar-scroll">

          <div className={`save-status ${hasUnsavedChanges ? 'unsaved' : ''}`} role="status">
            <strong>{isFileBusy ? 'Opening file…' : hasUnsavedChanges ? 'Changes not saved' : lastSavedAt ? 'Saved file loaded / downloaded' : 'Start a new take-off'}</strong>
            <p>{hasInvalidCoverage ? 'Enter positive material coverage values before saving.' : hasInvalidWaste ? 'Correct or clear the material waste percentage before saving.' : hasInvalidRates ? 'Correct or clear the invalid rate before saving.' : hasInvalidHeight ? 'Correct or clear the invalid wall height before saving.' : hasDraft ? 'Finish or cancel your current measurement or calibration to save.'
              : 'Save Measure downloads one file with your PDF and measurements. Open Measure restores it on any device.'}</p>
            {lastSavedAt && <span>Last saved: {new Date(lastSavedAt).toLocaleString()}</span>}
          </div>
          <div className="measured-work-list" hidden={sidebarTab !== 'groups'}>
            <h2>Measured Work</h2>
            <div className="measured-work-page-controls" aria-label="Measured Work drawing navigation">
              <button aria-label="Previous Measured Work drawing" disabled={pageNumber <= 1} onClick={() => goToDrawingPage(pageNumber-1)}>‹</button>
              <select aria-label="Measured Work drawing page" value={pageNumber} disabled={!pdf} onChange={(event) => goToDrawingPage(Number(event.target.value))}>{drawingPages.map((page,index) => <option key={index} value={index+1}>{page.name} ({index+1}/{drawingPages.length})</option>)}</select>
              <button aria-label="Next Measured Work drawing" disabled={!pdf || pageNumber >= drawingPages.length} onClick={() => goToDrawingPage(pageNumber+1)}>›</button>
            </div>
            <p className="page-scope-note">Showing work on <strong>{drawingPageName(pageNumber)}</strong> only.</p>
            <p className="length-note">Choose a work item to see its quantities and measurements on the right.</p>
            <button className="show-all-work-button" disabled={hasDraft} aria-pressed={showingAllWork} onClick={openAllMeasuredWork}>Show All Work on This Drawing</button>
            <div className="work-buttons">
              {currentPageGroupSummaries.map((group) => {
                const lockState = workLockState(group.id,pageNumber)
                return <div className="work-item-row" key={group.id} onContextMenu={(event) => openWorkMenu(event, group.id, pageNumber)}>
                  <button className="work-item-button" aria-pressed={selectedWorkId === group.id} disabled={hasDraft} onClick={() => openMeasuredWork(group.id)}>
                    <strong>{group.name || group.id}</strong><span>{categories.find((category) => category.id === group.categoryId)?.name || 'Uncategorised'} · {group.members.length} measurements · {drawingPageName(pageNumber)}</span>
                  </button>
                  <button className={`work-padlock is-${lockState}`} aria-label={`${group.name || group.id}: ${lockState}. Click to ${lockState === 'locked' ? 'unlock' : 'lock'} measurements on this drawing`} title={lockState === 'mixed' ? 'Mixed locks — click to lock this drawing' : lockState === 'empty' ? 'No measurements to lock' : lockState === 'locked' ? 'Unlock measurements on this drawing' : 'Lock measurements on this drawing'} disabled={lockState === 'empty'} onClick={() => { stopMeasurement(); setWorkLocked(group.id, lockState !== 'locked', pageNumber) }}>
                    <UiIcon name={lockState === 'locked' ? 'lock' : lockState === 'mixed' ? 'mixed-lock' : 'unlock'} />
                  </button>
                </div>
              })}
            </div>
            {!currentPageGroupSummaries.length && <p className="length-note">No measured work on {drawingPageName(pageNumber)} yet.</p>}

          </div>

          {ratesPanel('contractor')}
          {ratesPanel('subcontractor')}
          <div hidden={sidebarTab !== 'export'} className="export-panel"><h2>Export</h2><p className="length-note">Export options will be added here.</p></div>
          <div hidden={sidebarTab !== 'materials'} className="materials-panel"><h2>Materials</h2><fieldset className="material-scope-filters"><legend>Order materials for</legend><label>Trade<select aria-label="Materials trade" value={materialTrade} onChange={event=>setMaterialTrade(event.target.value as MaterialTrade)}><option value="all">All trades</option>{(['Tack','Dab','Skim','Insulation','Metal'] as WorkHeading[]).map(trade=><option key={trade} value={trade}>{trade}</option>)}</select></label><label>Drawing / floor<select aria-label="Materials drawing" value={materialDrawingKey} onChange={event=>setMaterialDrawingKey(event.target.value)}><option value="all">All drawings</option>{drawingPages.map((page,index)=><option key={page.source+':'+page.page} value={page.source+':'+page.page}>{drawingPageName(index+1)}</option>)}</select></label>{(materialTrade!=='all' || materialDrawingKey!=='all') && <button type="button" onClick={()=>{setMaterialTrade('all');setMaterialDrawingKey('all')}}>Show entire plot</button>}</fieldset><p className="length-note">Exact quantities use your measured areas and each measurement’s board specification. Final quantities add waste and round up to whole boards, rolls or bags.</p><label className="material-waste-label">Default waste allowance (%)<input type="number" min="0" step="any" inputMode="decimal" aria-label="Material waste percentage" aria-invalid={!validWaste(materialWasteText)} value={materialWasteText} onChange={event=>setMaterialWasteText(event.target.value)} /></label><p className="length-note">Each material starts with this allowance. Change its own waste box in the quantities table to adjust it separately.</p>{hasInvalidWaste && <p role="alert" className="calibration-warning">Enter zero or a positive waste percentage for each material. Select All trades and All drawings to check every item.</p>}{(shownAdhesiveCoverage || shownSkimCoverage || shownInsulationThicknesses.size>0) && <fieldset className="material-coverage-settings"><legend>Material coverage</legend>{shownAdhesiveCoverage && <label>Dabbing adhesive (m² per bag)<input type="number" min="0.01" step="any" inputMode="decimal" aria-label="Dabbing adhesive coverage" value={adhesiveCoverageText} aria-invalid={adhesiveCoverageText.trim()==='' || !Number.isFinite(Number(adhesiveCoverageText)) || Number(adhesiveCoverageText)<=0} onChange={event=>setAdhesiveCoverageText(event.target.value)} /></label>}{shownSkimCoverage && <label>Skimming plaster (m² per bag)<input type="number" min="0.01" step="any" inputMode="decimal" aria-label="Skimming plaster coverage" value={skimCoverageText} aria-invalid={skimCoverageText.trim()==='' || !Number.isFinite(Number(skimCoverageText)) || Number(skimCoverageText)<=0} onChange={event=>setSkimCoverageText(event.target.value)} /></label>}{Object.keys(defaultInsulationCoverage).filter(thickness=>shownInsulationThicknesses.has(thickness)).map(thickness=><label key={thickness}>INS {thickness}mm (m² per roll)<input type="number" min="0.01" step="any" inputMode="decimal" aria-label={'INS '+thickness+'mm coverage'} value={insulationCoverageTexts[thickness]} aria-invalid={!insulationCoverageTexts[thickness]?.trim() || !Number.isFinite(Number(insulationCoverageTexts[thickness])) || Number(insulationCoverageTexts[thickness])<=0} onChange={event=>setInsulationCoverageTexts(current=>({...current,[thickness]:event.target.value}))} /></label>)}</fieldset>}{hasInvalidCoverage && <p role="alert" className="calibration-warning">Coverage must be greater than zero. Select All trades and All drawings to check all material settings.</p>}{materialSummary && <>{materialSummary.issues.length>0 && <details className="materials-issues"><summary>{materialSummary.issues.length} items to check</summary><ul>{materialSummary.issues.map((issue,index)=><li key={index}>{issue}</li>)}</ul></details>}</>}</div>
          <div hidden={sidebarTab !== 'summary'} className="summary-panel">
            <div className="summary-job-heading">{[job.site, job.plot ? 'Plot ' + job.plot : '', job.houseType, job.revision ? (/^rev\b/i.test(job.revision) ? job.revision : 'Rev ' + job.revision) : ''].filter(Boolean).join(' / ') || 'Job details not entered'}</div>
            <h2>Plot summary</h2>
            <div className="summary-view-switch" role="group" aria-label="Plot Summary view"><button type="button" aria-pressed={summaryPresentation==='detailed'} onClick={()=>setSummaryPresentation('detailed')}>Detailed</button><button type="button" aria-pressed={summaryPresentation==='simplified'} onClick={()=>setSummaryPresentation('simplified')}>Simplified</button></div>
            <div className="panel-subtitle">{measuredCategorySummaries.length} measured categories · all pages</div>
            <p className="length-note">Drawing visibility does not change these totals. Skim rows reuse the source areas and represent separate work.</p>
            {summaryPresentation==='detailed' && <>{orderedPlotCategories.map((category,index) => <div className="category-summary" key={category.id}>
              {(index===0 || summaryBlock(category)!==summaryBlock(orderedPlotCategories[index-1])) && <h3 className="summary-trade-heading">{summaryBlock(category)}</h3>}
              <strong><span className="category-swatch" style={{ background: category.color }} />{category.name || category.id}</strong>
              {category.mode === 'count' ? <div className="summary-values">{category.count} no.{workPriceLabel(category)}</div> : <div className="summary-values">
                <span>{category.totalAreaM2 === null ? 'Check calibration / heights' : `${category.totalAreaM2.toFixed(2)} m²`}</span>
                {category.mode !== 'derived' && <span>{category.totalMm === null ? 'LM awaiting calibration' : `${(category.totalMm / 1000).toFixed(2)} LM`}</span>}
                {workPriceLabel(category)}
              </div>}
              {category.mode === 'derived' && <details><summary>Automatic skim sources</summary>
                <p className="length-note">{category.id === 'skimmed-walls' ? 'From Tack Timber Studs, Tack Metal Studs and both Dabbed Wall categories.' : 'From Tack Ceiling.'} Source groups can opt out using Include this area in skim.</p>
                <ul className="group-members">{category.sourceGroups.map((group) => <li key={group.id}>{group.name || group.id} · {group.totalAreaM2 === null ? 'Check measurements' : `${group.totalAreaM2.toFixed(2)} m²`}</li>)}</ul>
              </details>}
              {category.wallsWithoutHeight > 0 && <p className="length-note">{category.wallsWithoutHeight} lengths/runs without height are excluded from m².</p>}
            </div>)}
            {!measuredCategorySummaries.length && <p className="length-note">No categories measured yet.</p>}
            {measuredCategorySummaries.length>0 && priceSubtotals(measuredCategorySummaries,'whole plot')}
            {measuredCategorySummaries.length>0 && <div className="plot-price-total"><span>{unpricedCategories ? 'Priced subcontractor subtotal' : 'Plot subcontractor total'}</span><strong>{pounds(plotPriceTotal)}</strong>{unpricedCategories>0 && <p>{unpricedCategories} categories awaiting a rate or valid quantities.</p>}<p>49p or less rounds down; 50p or more rounds up. Totals add the rounded category values. LM is not charged separately.</p>{measuredCategorySummaries.some(category=>category.wallsWithoutHeight>0) && <p>Lengths without wall heights are excluded from m² pricing.</p>}</div>}</>}{summaryPresentation==='simplified' && <p className="length-note">Whole-plot figures and drawing / floor breakdowns are shown in the tables.</p>}
            <p className="length-note">{groups.filter((group) => !group.categoryId).length} work items are uncategorised. Assign categories in Measured Work settings to include them above. Ungrouped geometry is also excluded.</p>
            <details className="category-settings"><summary>Edit category names and colours</summary>
              {categories.map((category) => <div className="category-editor" key={category.id}>
                <input aria-label={`Name category ${category.id}`} value={category.name} maxLength={100} onChange={(event) => updateCategory(category.id, { name: event.target.value })} />
                <input type="color" aria-label={`Colour for ${category.name || category.id}`} value={category.color} onChange={(event) => updateCategory(category.id, { color: event.target.value })} />
              </div>)}
              <form onSubmit={(event) => { event.preventDefault(); createCategory() }}>
                <label>Custom work category<input value={newCategoryName} placeholder="Category name" maxLength={100} onChange={(event) => setNewCategoryName(event.target.value)} /></label>
                <label>Colour<input type="color" value={newCategoryColor} onChange={(event) => setNewCategoryColor(event.target.value)} /></label>
                <label>Category type<select value={newCategoryMode} onChange={(event) => setNewCategoryMode(event.target.value as 'measure' | 'count')}>
                  <option value="measure">Measure — lengths and areas</option>
                  <option value="count">Point — marks and quantity count</option>
                </select></label>
                <button type="submit" disabled={!newCategoryName.trim()}>Add Category</button>
              </form>
            </details>
          </div>

          <div hidden={sidebarTab !== 'measure'} className="drawing-controls">
          <div className="toolbox-heading"><UiIcon name="file" /><h2>Drawings</h2></div>
          <label className={`import-pages-button ${!pdf || isFileBusy ? 'file-disabled' : ''}`}><UiIcon name="import" />Import Additional Pages
            <input type="file" accept="application/pdf" multiple disabled={!pdf || isFileBusy} onChange={(event) => { const files=Array.from(event.target.files ?? []); event.target.value=''; if (files.length) void importDrawingPages(files) }} />
          </label>
          {pdf && <div className="drawing-page-manager">
            <label>Drawing page<select aria-label="Select drawing page" value={pageNumber} onChange={(event) => goToDrawingPage(Number(event.target.value))}>{drawingPages.map((page,index) => <option key={index} value={index+1}>{index+1}. {page.name}</option>)}</select></label>
            <details><summary>Rename or remove pages</summary>
              {drawingPages.map((page,index) => <div className={`drawing-page-row ${pageNumber === index+1 ? 'is-current' : ''}`} key={index}>
                <button className="page-number-button" onClick={() => goToDrawingPage(index+1)} title={`Go to ${page.name}`}>{index+1}</button>
                <input aria-label={`Name for drawing page ${index+1}`} maxLength={80} defaultValue={page.name} key={page.source + ':' + page.page + ':' + page.name} onBlur={(event) => { const value=event.target.value.trim(); if (value) renameDrawingPage(index+1,value); else event.target.value=page.name }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} />
                <button className="delete-page-button" aria-label={`Delete drawing page ${page.name}`} disabled={drawingPages.length <= 1 || hasDraft} title={drawingPages.length <= 1 ? 'Keep at least one drawing page' : 'Remove this page and its measurements'} onClick={(event) => requestPageDelete(index+1,event.currentTarget)}>×</button>
              </div>)}
            </details>
          </div>}

          <div className="tool-row">
            <button
              disabled={!pdf || pageNumber <= 1 || runMode || areaMode}
              onClick={previousPage}
              title="Previous page"
            >
              ←
            </button>

            <span>
              Page {pageNumber}
              {pdf ? ` / ${pdf.numPages}` : ''}
            </span>

            <button
              disabled={!pdf || pageNumber >= (pdf?.numPages ?? 1) || runMode || areaMode}
              onClick={nextPage}
              title="Next page"
            >
              →
            </button>
          </div>

          <button
            className="wide-control"
            disabled={!pdf}
            onClick={fitPage}
          >
            Fit Page
          </button>

          <div className="rotate-row">
            <button
              disabled={!pdf}
              onClick={rotateLeft}
              title="Rotate 90° left and refit page"
            >
              ↶ 90°
            </button>

            <button
              disabled={!pdf}
              onClick={rotateRight}
              title="Rotate 90° right and refit page"
            >
              90° ↷
            </button>
          </div>

          <div className="zoom-control">
            <div className="zoom-heading">
              <span>Zoom</span>
              <strong>{Math.round(scale * 100)}%</strong>
            </div>

            <input
              className="zoom-slider"
              type="range"
              min="25"
              max="1500"
              step="5"
              value={zoomPercent}
              disabled={!pdf}
              onChange={(event) => handleZoomSlider(event.target.value)}
            />

            <div className="zoom-labels">
              <span>25%</span>
              <span>1500%</span>
            </div>
          </div>

          <div className="view-status">
            {pdf
              ? `${viewMode === 'fit-page' ? 'Fit page' : 'Manual zoom'} · ${rotation}°`
              : 'No drawing loaded'}
          </div>

          <hr />

          </div>


          <div hidden={sidebarTab!=='measure'} className={`measure-panel-layer${toolboxDocked ? ' is-sidebar-docked' : ''}`}>
                <div hidden={sidebarTab!=='measure'} ref={toolboxRef} className={`measure-toolbox floating-toolbox icon-only-toolbox description-toolbox compact-floating-panel ${toolboxDocked ? 'is-docked' : 'is-floating'}`} role="region" aria-label="Movable measurement toolbox" tabIndex={0} title="Drag any empty space to move this panel" onPointerDown={startToolboxDrag} onPointerMove={moveToolboxDrag} onPointerUp={endToolboxDrag} onPointerCancel={endToolboxDrag} onKeyDown={moveIconToolbarWithKeys} onContextMenu={openPanelMenu} style={toolboxDocked ? {} : {left:toolbarOrigin.x+toolboxPosition.x,top:toolbarOrigin.y+toolboxPosition.y,maxWidth:'calc(100vw - 16px)'}} onWheel={event=>event.stopPropagation()}>
          <div className="panel-description-header">
          <details className="toolbar-description" data-no-drag open={descriptionOpen} onToggle={event=>setDescriptionOpen(event.currentTarget.open)}><summary ref={descriptionSummaryRef} aria-label="Choose Work Description" title="Work Description" onClick={event=>positionDescriptionMenu(event.currentTarget)}><strong>{workDescriptionLabel(chooserCategoryId || activeCategory?.id || 'tack-ceiling',categories)} <span aria-hidden="true">▾</span></strong></summary><div className="description-popover" data-no-drag ref={descriptionMenuRef} style={{left:descriptionPosition.x,top:descriptionPosition.y}} onKeyDown={descriptionMenuKeys}>
          <div className="description-heading-list" aria-label="Work Description headings">
            {descriptionSections.map(section=><button type="button" key={section.title} data-description-heading={section.title} aria-haspopup="menu" aria-expanded={hoverHeading===section.title} className="description-heading-button" onMouseEnter={()=>setHoverHeading(section.title as WorkHeading)} onFocus={()=>setHoverHeading(section.title as WorkHeading)} onClick={()=>setHoverHeading(section.title as WorkHeading)}>{section.title}</button>)}
          </div>
          <button type="button" className="create-new-description" onClick={openNewDescription}>Create New</button>
          {hoverHeading && <div className="description-submenu" ref={descriptionSubmenuRef} style={{top:submenuTop}} role="menu" aria-label={hoverHeading+' Work Descriptions'}>
            <h3>{hoverHeading==='Other' ? 'Other work' : hoverHeading}<button type="button" className="reorder-descriptions" aria-pressed={reorderDescriptions} onClick={()=>setReorderDescriptions(value=>!value)}>{reorderDescriptions ? 'Done' : 'Reorder'}</button></h3>
            {descriptionOptions(hoverHeading).map(({category,label},index,list)=><div className="description-option-row" key={category.id}>{category.mode==='derived' ? <div className="automatic-description">{label}<small>Automatic</small></div> : <button type="button" role="menuitemradio" aria-checked={category.id===(chooserCategoryId || activeCategory?.id || 'tack-ceiling')} onClick={()=>{if(!reorderDescriptions){changeToolCategory(category.id);setDescriptionOpen(false)}}}>{category.name!==initialCategories.find(item=>item.id===category.id)?.name ? category.name : label}</button>}{reorderDescriptions && hoverHeading!=='Other' && <div className="description-order-actions"><button type="button" aria-label={'Move '+label+' up'} disabled={index===0} onClick={()=>moveDescription(hoverHeading,category.id,-1)}>↑</button><button type="button" aria-label={'Move '+label+' down'} disabled={index===list.length-1} onClick={()=>moveDescription(hoverHeading,category.id,1)}>↓</button></div>}</div>)}
            {hoverHeading==='Skim' && <p className="automatic-skim-note">N.B. Skim is calculated automatically from Tack and Dab measurements. Custom work is included when enabled.</p>}
          </div>}
          </div></details>
          <button type="button" className="panel-messages-toggle" data-no-drag aria-label={messagesHidden ? 'Show messages' : 'Hide messages'} aria-pressed={!messagesHidden} title={messagesHidden ? 'Show messages' : 'Hide messages'} onClick={()=>setMessagesHidden(hidden=>!hidden)}><UiIcon name={messagesHidden ? 'eye-off' : 'eye'} /></button>
          </div>
                  <div className="toolbox-body">
          <div className="compact-tool-row"><div className="compact-measure-group"><small>Measure</small><div className="tool-selector-grid" aria-label="Measurement tools">
            <button className="tool-tile" aria-label="Single Length" title={(!lengthCalibrationValid || calibrationMode || pendingCalibration) ? measurementToolHelp() : 'Single Length'} onMouseEnter={() => { if (!lengthCalibrationValid || calibrationMode || pendingCalibration) setToolCalibrationNotice(measurementToolHelp()) }} onFocus={() => { if (!lengthCalibrationValid || calibrationMode || pendingCalibration) setToolCalibrationNotice(measurementToolHelp()) }} aria-pressed={!toolDoorHead && (lengthMode || readyToolKind === 'length')} aria-disabled={calibrationMode || !!pendingCalibration || !lengthCalibrationValid}
              onClick={() => activateMeasurementTool('length')}>
              <UiIcon name="length" /><span>{'Single Length'}</span>
            </button>
            <button className="tool-tile" aria-label="Multiple Length" title={(!lengthCalibrationValid || calibrationMode || pendingCalibration) ? measurementToolHelp() : 'Multiple Length'} onMouseEnter={() => { if (!lengthCalibrationValid || calibrationMode || pendingCalibration) setToolCalibrationNotice(measurementToolHelp()) }} onFocus={() => { if (!lengthCalibrationValid || calibrationMode || pendingCalibration) setToolCalibrationNotice(measurementToolHelp()) }} aria-pressed={runMode || readyToolKind === 'run'} aria-disabled={!lengthCalibrationValid || calibrationMode || !!pendingCalibration}
              onClick={() => activateMeasurementTool('run')}><UiIcon name="run" /><span>Multiple Length</span></button>
            <button className="tool-tile" aria-label="Area" title={(!lengthCalibrationValid || calibrationMode || pendingCalibration) ? measurementToolHelp() : 'Area'} onMouseEnter={() => { if (!lengthCalibrationValid || calibrationMode || pendingCalibration) setToolCalibrationNotice(measurementToolHelp()) }} onFocus={() => { if (!lengthCalibrationValid || calibrationMode || pendingCalibration) setToolCalibrationNotice(measurementToolHelp()) }} aria-pressed={areaMode || readyToolKind === 'area'} aria-disabled={!lengthCalibrationValid || calibrationMode || !!pendingCalibration}
              onClick={() => activateMeasurementTool('area')}><UiIcon name="area" /><span>Area</span></button>
            <button type="button" className="tool-tile" aria-label="Door Head" aria-pressed={toolDoorHead && currentToolKind()==='length'} title="Door Head - Both Faces" aria-disabled={!lengthCalibrationValid || calibrationMode || !!pendingCalibration} onClick={activateDoorHead}><UiIcon name="door-head" /><span>Door Head</span></button>
            <button className="tool-tile" aria-label="Point Marker" title={(!lengthCalibrationValid || calibrationMode || pendingCalibration) ? measurementToolHelp() : 'Point Marker'} onMouseEnter={() => { if (!lengthCalibrationValid || calibrationMode || pendingCalibration) setToolCalibrationNotice(measurementToolHelp()) }} onFocus={() => { if (!lengthCalibrationValid || calibrationMode || pendingCalibration) setToolCalibrationNotice(measurementToolHelp()) }} aria-pressed={countMode || readyToolKind === 'point'} aria-disabled={!lengthCalibrationValid || calibrationMode || !!pendingCalibration}
              onClick={() => activateMeasurementTool('point')}><UiIcon name="point" /><span>Point Marker</span></button>
          </div>

          </div><div className="compact-snap-group"><small>Snap types</small><div className="compact-snap-buttons">
            <button title="Snap to lines on/off" aria-label="Snap to lines" aria-pressed={snapEnabled} onClick={()=>setSnapEnabled(value=>!value)}><UiIcon name="snap" /></button>
            <button title="Snap to start/end points" aria-label="Start / end" aria-pressed={snapEndpoints} disabled={!snapEnabled} onClick={()=>setSnapEndpoints(value=>!value)}><UiIcon name="endpoint" /></button>
            <button title="Snap to midpoints" aria-label="Midpoints" aria-pressed={snapMidpoints} disabled={!snapEnabled} onClick={()=>setSnapMidpoints(value=>!value)}><UiIcon name="midpoint" /></button>
          </div>
          {snapEnabled && <div className="snap-source-icons" role="group" aria-label="Snap source">
            <button type="button" aria-label="PDF lines" title="Snap to PDF lines" aria-pressed={snapSource==='pdf'} onClick={()=>setSnapSource('pdf')}><UiIcon name="snap-pdf" /></button>
            <button type="button" aria-label="Measured lines" title="Snap to measured lines" aria-pressed={snapSource==='measure'} onClick={()=>setSnapSource('measure')}><UiIcon name="snap-measure" /></button>
            <button type="button" aria-label="PDF and measured lines" title="Snap to PDF and measured lines" aria-pressed={snapSource==='both'} onClick={()=>setSnapSource('both')}><UiIcon name="snap-both" /></button>
          </div>}
          </div></div>
                  </div>
          {pointOptionsOpen && <div className="point-marker-options" data-no-drag role="group" aria-label="Point marker options"><label>Point type<select aria-label="Point marker type" value={pointMarkerKind} onChange={event=>selectPointMarker(pointTrade,event.target.value as PointMarkerKind)}>{(Object.keys(pointMarkerLabels) as PointMarkerKind[]).map(kind=><option key={kind} value={kind}>{pointMarkerLabels[kind]}</option>)}</select></label><div className="point-trade-buttons" role="group" aria-label="Point marker trade">{pointTrades.map(trade=><button type="button" key={trade} aria-pressed={pointTrade===trade} onClick={()=>selectPointMarker(trade,pointMarkerKind)}>{trade}</button>)}</div></div>}

          <label hidden={currentToolKind()==='area' || currentToolKind()==='point'} className={`toolbox-height panel-wall-height${toolWallHeight==='' && (currentToolKind()==='length' || currentToolKind()==='run') ? ' height-reminder' : ''}`}>Wall Height<div><input type="number" min="0.001" step="0.01" inputMode="decimal" aria-label="Toolbox wall height" value={heightInMm(toolWallHeight)} disabled={areaMode || countMode} onChange={(event) => {
            const value=heightFromMm(event.target.value); setToolWallHeight(value)
            if (value === '' || (Number.isFinite(Number(value)) && Number(value)>0)) setRunHeightM(value === '' ? undefined : Number(value))
          }} /><span>mm</span></div></label>
          {toolDoorHead && currentToolKind()==='length' && <p className="door-head-note" role="status">Door head · 2000mm opening · 2 faces{!(Number(toolWallHeight)>2) && <strong> — enter wall height above 2000mm.</strong>}</p>}
          <div className={`panel-board-spec${toolBoardSelection()===undefined ? ' board-spec-reminder' : ''}`} data-no-drag><span>Board Specification</span><button type="button" className="board-spec-value" aria-label="Choose board specification" aria-haspopup="dialog" aria-expanded={boardPickerOpen && !boardTarget} data-board-picker onClick={event=>openBoardPicker(null,event.currentTarget)}>{boardSpecLabel(toolBoardSelection())}<span aria-hidden="true"> ▾</span></button>
          {boardHeightMismatch(toolBoardSelection(),currentToolKind()==='area' || currentToolKind()==='point' ? undefined : Number(toolWallHeight)||undefined) && <p className="board-height-warning" role="alert">Board length is shorter than the wall height. <button type="button" onClick={event=>openBoardPicker(null,event.currentTarget)}>Change / override</button></p>}</div>
            <div className={`toolbar-session-status${currentToolKind() ? ' compact-measurement-progress' : ''}`} role="region" aria-label="Measurement progress" hidden={(messagesHidden && !currentToolKind()) || (!currentToolKind() && !toolCalibrationNotice && !toolSwitchNotice && !toolHeightInvalid && !(snapEnabled && (snapSource!=='measure' && pdfSnapInfo!=='PDF lines ready.' || !snapEndpoints && !snapMidpoints)))}>
          <div className="measurement-notices" hidden={messagesHidden || !!currentToolKind()}>
          {snapEnabled && snapSource!=='measure' && pdfSnapInfo!=='PDF lines ready.' && <p className="length-note">{pdfSnapInfo}</p>}
          {snapEnabled && !snapEndpoints && !snapMidpoints && <p className="length-note">Choose a snap point type.</p>}
          {toolCalibrationNotice && <p className="tool-calibration-help" role="status">{toolCalibrationNotice}</p>}
          {toolSwitchNotice && <p className="tool-switch-notice" role="status">{toolSwitchNotice}</p>}
          {toolHeightInvalid && <p className="calibration-warning">Enter a height greater than zero, or leave it blank.</p>}
          {readyToolKind && <div className="ready-tool-banner" role="status"><strong>Ready for the next {readyToolKind === 'point' ? 'point marker' : readyToolKind === 'length' ? 'length' : readyToolKind}.</strong><div>{activeGroup?.name || activeCategory?.name} · click a new start point.</div></div>}
          {(lengthMode || runMode || areaMode || countMode) && <div className="measuring-banner" role="status">
            <strong>{activeCategory?.name || 'Uncategorised'}</strong>
            <div>{activeGroup?.name || 'Ungrouped'} · {lengthMode ? lengthPoints.length ? 'Click the second point to finish' : 'Click the start point' : 'Press Enter to finish'}</div>
          </div>}



          </div>
          {currentToolKind() && <div className="compact-progress-strip" role="group" aria-label="Measurement controls">
            <output className="compact-progress-figure" aria-label="Current measurement" aria-live="polite" title={areaMode && draftAreaProblem ? draftAreaProblem : toolHeightInvalid ? 'Enter a height greater than zero, or leave it blank.' : undefined}>
              {currentToolKind()==='point' ? countSessionIdsRef.current.length+(countSessionIdsRef.current.length===1 ? ' pt' : ' pts') : currentToolKind()==='area' ? (draftAreaM2===null ? '—' : draftAreaM2.toFixed(2))+' m²' : (draftTotalMm/1000).toFixed(2)+' m'}
            </output>
            <button type="button" className="compact-progress-action progress-finish" aria-label="Finish measurement" title={lengthMode || readyToolKind==='length' ? 'Single lengths finish automatically at the second point' : areaMode && draftAreaProblem ? draftAreaProblem : toolHeightInvalid ? 'Correct or clear the wall height before finishing' : 'Finish measurement (Enter)'} disabled={!!readyToolKind || lengthMode || (runMode && (runPoints.length<2 || !lengthCalibrationValid || toolHeightInvalid)) || (areaMode && (!!draftAreaProblem || !lengthCalibrationValid))} onClick={()=>{if(runMode)finishRun();else if(areaMode)finishArea();else if(countMode)finishCounting()}}><span aria-hidden="true">✓</span></button>
            <button type="button" className="compact-progress-action progress-undo" aria-label="Undo last point" title="Undo last point" disabled={!!readyToolKind || (lengthMode ? !lengthPoints.length : runMode ? !runPoints.length : areaMode ? !areaPoints.length : !countSessionIdsRef.current.length)} onClick={()=>{if(lengthMode)setLengthPoints([]);else if(runMode)setRunPoints(points=>points.slice(0,-1));else if(areaMode)setAreaPoints(points=>points.slice(0,-1));else if(countMode){const id=countSessionIdsRef.current.pop();if(id)setCountMeasurements(current=>({...current,[pageNumber]:(current[pageNumber]??[]).filter(item=>item.id!==id)}))}}}><span aria-hidden="true">↶</span></button>
            <button type="button" className="compact-progress-action progress-cancel" aria-label="Cancel measurement" title="Cancel measurement (Esc)" onClick={()=>{if(lengthMode)cancelLengthMeasurement();else if(runMode)cancelRun();else if(areaMode)cancelArea();else stopMeasurement()}}><span aria-hidden="true">✕</span></button>
          </div>}
            </div>
                </div>
          </div>

          <div hidden={sidebarTab !== 'measure'} className="measurement-history">          {currentRuns.length > 0 && (
            <details className={`run-panel measurement-section ${lengthCalibrationValid ? '' : 'invalid'}`}>
              <summary>Wall runs ({currentRuns.length}) · {lengthCalibrationValid ? `${(currentRuns.reduce((sum, run) => sum + runSegments(run.points).reduce((a, b) => a + b, 0), 0) / 1000).toFixed(2)} m` : 'Calibration required'}</summary>
              {!lengthCalibrationValid && <p className="calibration-warning">Recalibrate and lock this page before using these totals.</p>}
              <div className="length-list run-list">
                {currentRuns.map((run) => {
                  const segments = runSegments(run.points)
                  const totalMm = segments.reduce((sum, mm) => sum + mm, 0)
                  return (
                    <details className="run-list-item measurement-card" key={run.id}>
                      <summary>{run.name || run.id} · {lengthCalibrationValid ? `${(totalMm / 1000).toFixed(2)} m` : '—'}
                        <span>{categories.find((category) => category.id === groups.find((group) => group.id === run.groupId)?.categoryId)?.name || 'Uncategorised'}</span>
                      </summary>
                      <div className="length-panel-heading">
                        <strong>{run.id}</strong>
                        <div className="length-item-actions">
                          <label className="length-lock-control">
                            <input type="checkbox" checked={run.locked} onChange={() => toggleRunLock(run.id)} aria-label={`Lock ${run.id}`} />
                            <span>Lock</span>
                          </label>
                          <button className="delete-length-button" onClick={() => deleteRun(run.id)} aria-label={`Delete ${run.id}`}>×</button>
                        </div>
                      </div>
                      {measurementDetails(run.id, run.name, run.groupId)}
                      <div className="length-primary">{lengthCalibrationValid ? `${(totalMm / 1000).toFixed(2)} m` : 'Calibration required'}</div>
                      {wallHeightField(run.id, run.heightM, lengthCalibrationValid ? totalMm : null)}
                      <details>
                        <summary>{segments.length} segments — show lengths</summary>
                        <ol className="run-segments">
                          {segments.map((mm, i) => <li key={i}>{lengthCalibrationValid ? `${(mm / 1000).toFixed(2)} m` : 'Calibration required'}</li>)}
                        </ol>
                      </details>
                      {!run.locked && <p className="length-note">Drag a corner on the drawing to edit. Tick Lock when finished.</p>}
                    </details>
                  )
                })}
              </div>
            </details>
          )}

          {currentLengthMeasurements.length > 0 && (
            <details
              className={`length-panel measurement-section ${
                lengthCalibrationValid ? '' : 'invalid'
              }`}
            >
              <summary className="length-panel-heading">
                <strong>
                  Lengths ({currentLengthMeasurements.length}) · {lengthCalibrationValid ? `${(renderedLengths.reduce((sum, item) => sum + (item.doorHead ? 0 : item.lengthMm ?? 0), 0) / 1000).toFixed(2)} m` : 'Calibration required'}
                </strong>
              </summary>
                <button
                  className="clear-all-lengths"
                  onClick={clearAllLengths}
                >
                  Clear all
                </button>

              {!lengthCalibrationValid && (
                <div className="calibration-warning">
                  Recalibrate and lock this page before using these measurements.
                </div>
              )}

              <div className="length-list">
                {renderedLengths.map((measurement) => (
                  <details
                    className="length-list-item named-length-item measurement-card"
                    key={measurement.id}
                  >
                    <summary>{measurement.doorHead ? 'Door head · ' : ''}{measurement.name || measurement.id} · {measurement.lengthMm === null ? '—' : `${(measurement.lengthMm / 1000).toFixed(2)} m`}
                      <span>{categories.find((category) => category.id === groups.find((group) => group.id === measurement.groupId)?.categoryId)?.name || 'Uncategorised'}</span>
                    </summary>
                    <div>
                      <strong>{measurement.id}</strong>

                      {measurement.lengthMm !== null ? (
                        <>
                          <div className="length-primary">
                            {(measurement.lengthMm / 1000).toFixed(2)} m
                          </div>
                          <div className="length-secondary">
                            {Math.round(measurement.lengthMm).toLocaleString()} mm
                          </div>
                        </>
                      ) : (
                        <div className="length-secondary">
                          Calibration required
                        </div>
                      )}
                    </div>

                    <div className="length-item-actions">
                      <label
                        className="length-lock-control"
                        title={
                          measurement.locked
                            ? 'Unlock this measurement to move its end points'
                            : 'Lock this measurement so its end points do not block new clicks'
                        }
                      >
                        <input
                          type="checkbox"
                          checked={measurement.locked}
                          onChange={() =>
                            toggleLengthLock(measurement.id)
                          }
                        />
                        <span>Lock</span>
                      </label>

                      <button
                        className="delete-length-button"
                        onClick={() =>
                          deleteLengthMeasurement(measurement.id)
                        }
                        title={`Delete ${measurement.id}`}
                      >
                        ×
                      </button>
                    </div>
                    {measurementDetails(measurement.id, measurement.name, measurement.groupId)}
                    {wallHeightField(measurement.id, measurement.heightM, measurement.lengthMm)}
                  </details>
                ))}
              </div>

              <div className="length-note">
                Fine-tune a measurement, then tick Lock. Locked end points do not
                intercept clicks, so another length can start from the same corner.
              </div>
            </details>
          )}


          {currentAreas.length > 0 && <details className={`area-panel measurement-section ${lengthCalibrationValid ? '' : 'invalid'}`}>
            <summary>Areas ({currentAreas.length}) · {lengthCalibrationValid ? `${(currentAreas.reduce((sum, area) => sum + polygonArea(area.points), 0) * currentCalibration.mmPerPdfUnit ** 2 / 1000000).toFixed(2)} m²` : 'Calibration required'}</summary>
            {!lengthCalibrationValid && <p className="calibration-warning">Calibrate and lock this page to show areas.</p>}
            <div className="length-list run-list">
              {currentAreas.map((area) => (
                <details className="area-list-item measurement-card" key={area.id}>
                  <summary>{area.name || area.id} · {lengthCalibrationValid ? `${(polygonArea(area.points) * currentCalibration.mmPerPdfUnit ** 2 / 1000000).toFixed(2)} m²` : '—'}
                    <span>{categories.find((category) => category.id === groups.find((group) => group.id === area.groupId)?.categoryId)?.name || 'Uncategorised'}</span>
                  </summary>
                  <div className="length-panel-heading">
                    <strong>{area.id}</strong>
                    <div className="length-item-actions">
                      <label className="length-lock-control">
                        <input type="checkbox" checked={area.locked} aria-label={`Lock ${area.id}`} onChange={() => toggleAreaLock(area.id)} />
                        <span>Lock</span>
                      </label>
                      <button className="delete-length-button" aria-label={`Delete ${area.id}`} onClick={() => deleteArea(area.id)}>×</button>
                    </div>
                  </div>
                  {measurementDetails(area.id, area.name, area.groupId)}
                  <div className="area-primary">{lengthCalibrationValid ? `${(polygonArea(area.points) * currentCalibration.mmPerPdfUnit ** 2 / 1000000).toFixed(2)} m²` : 'Calibration required'}</div>
                  <div>{area.points.length} corners</div>
                  {!area.locked && <p className="length-note">Drag a corner to adjust the outline, then tick Lock.</p>}
                </details>
              ))}
            </div>
          </details>}


          {currentCounts.length > 0 && <details className="count-panel measurement-section">
            <summary>Point marks ({currentCounts.length}) · this page</summary>
            <div className="length-list run-list">{currentCounts.map((count) => <details className="count-list-item measurement-card" key={count.id}>
              <summary>{count.name || count.id}<span>{categories.find((category) => category.id === countCategoryId(count))?.name || 'Point'} · 1 no.</span></summary>
              <div className="length-panel-heading"><strong>{count.id}</strong><div className="length-item-actions">
                <label className="length-lock-control"><input type="checkbox" checked={count.locked} aria-label={`Lock ${count.id}`} onChange={() => toggleCountLock(count.id)} />Lock</label>
                <button className="delete-length-button" aria-label={`Delete ${count.id}`} onClick={() => deleteCount(count.id)}>×</button>
              </div></div>
              {measurementDetails(count.id, count.name, count.groupId)}
            </details>)}</div>
          </details>}
</div>

          <p className="status" role="status">{status}</p>
          </div>
        </aside>

        <section
          hidden={sidebarTab === 'summary' || sidebarTab === 'materials' || sidebarTab === 'export' || sidebarTab === 'rates' || sidebarTab === 'contractor-rates'}
          ref={stageRef}
          tabIndex={-1}
          className={`drawing-stage${hoveredMeasurementId ? ' measurement-hover' : ''}${isPanning ? ' is-panning' : ''}${calibrationMode || lengthMode || runMode || areaMode || countMode || readyToolKind ? ' measurement-active' : ''}`}
          onPointerDown={(event) => { setSnapPreview(null); startPan(event) }}
          onPointerMove={(event) => { movePan(event); previewSnap(event); updateMeasurementHover(event) }}
          onPointerLeave={() => {setSnapPreview(null);setHoveredMeasurementId(null)}}
          onContextMenu={openMeasurementMenu}
          onPointerUp={endPan}
          onPointerCancel={(event) => {
            panStartRef.current.moved = true
            endPan(event)
          }}
          onWheel={handleWheelZoom}
        >
          {!pdf && (
            <label className="drop-zone">
              <strong>Import a construction drawing</strong>
              <span>PDF only for the first prototype</span>

              <input
                type="file"
                accept="application/pdf"
                disabled={isFileBusy}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''

                  if (file) {
                    openPdf(file)
                  }
                }}
              />
            </label>
          )}

          {pdf && (drawingRendering || drawingRenderError) && <div className="drawing-render-message" role={drawingRenderError ? 'alert' : 'status'} onPointerDown={event=>event.stopPropagation()}>
            {drawingRenderError ? <><strong>Drawing could not be displayed</strong><p>{drawingRenderError}</p><button type="button" onClick={()=>setDrawingRenderRetry(value=>value+1)}>Retry drawing</button></> : 'Loading drawing…'}
          </div>}

          {pdf && (
            <div
              ref={drawingRef}
              className="drawing-positioner"
              style={{
                width: viewportSize.width,
                height: viewportSize.height,
                transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))`,
              }}
            >
              <canvas ref={canvasRef} />

              <svg
                className={`measurement-overlay${overviewDrawing ? ' overview-drawing' : ''}${sidebarTab==='groups' ? ' work-drawing' : ''}${isolatedMeasurementId ? ' has-isolated-measurement' : ''}`}
                width={viewportSize.width}
                height={viewportSize.height}
                style={{
                  pointerEvents: 'none',
                }}
              >
                {renderedAreas.map((area) => (
                  <g key={area.id} className={sidebarTab==='groups' && isInsulationArea(area.groupId) && isolatedMeasurementId!==area.id ? 'insulation-area-overview' : undefined} opacity={measurementAppearance(area.groupId).opacity}>
                    {area.handles.length > 1 && (area.id === 'Draft area'
                      ? <polyline points={area.handles.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={area.color} strokeWidth={measurementAppearance(area.groupId).width} strokeDasharray="7 4" />
                      : <polygon points={area.handles.map((p) => `${p.x},${p.y}`).join(' ')} fill={`${area.color}22`} stroke={area.color} strokeWidth={measurementAppearance(area.groupId).width} />)}
                    {area.id !== 'Draft area' && area.handles.length > 0 && (() => {
                      const center=polygonLabelPoint(area.handles), label=area.areaM2 === null ? 'Calibration required' : area.areaM2.toFixed(2)+' m²',width=label.length*9+22
                      return <g className="area-value-label" transform={`translate(${center.x},${center.y})`} pointerEvents="none"><title>{area.id}</title><rect x={-width/2} y={-16} width={width} height="32" rx="5" fill="white" fillOpacity="0.95" stroke={area.color} strokeWidth="1" /><text textAnchor="middle" dominantBaseline="central" className="area-quantity-text">{label}</text></g>
                    })()}
                    {area.handles.map((point, i) => <circle key={i} cx={point.x} cy={point.y} r={area.locked ? 5 : 8}
                      fill={area.color} stroke="white" strokeWidth="2"
                      style={{ pointerEvents: !area.locked && lengthCalibrationValid && !hasDraft ? 'all' : 'none', cursor: 'move' }}
                      className={isSelectedPoint(area.id,i) ? 'selected-edit-point' : undefined} onContextMenu={(event)=>openPointMenu(event,area.id,'area',i)}
                      onPointerDown={(event) => startAreaHandleDrag(event, area.id, i)}
                      onPointerMove={moveAreaHandle} onPointerUp={endAreaHandleDrag} onPointerCancel={endAreaHandleDrag} />)}
                  </g>
                ))}

                {calibrationVisible && sidebarTab==='measure' && <g className="calibration-overlay" aria-label="Drawing calibration">
                {calibrationLine && (
                  <line
                    x1={calibrationLine.x1}
                    y1={calibrationLine.y1}
                    x2={calibrationLine.x2}
                    y2={calibrationLine.y2}
                    stroke="#e11d48"
                    strokeWidth="3"
                  />
                )}

                {pointAHandle && (
                  <>
                    <circle
                      cx={pointAHandle.x}
                      cy={pointAHandle.y}
                      r="9"
                      fill="#f59e0b"
                      stroke="#ffffff"
                      strokeWidth="2"
                      style={{
                        pointerEvents: runMode || areaMode || countMode || (currentCalibration?.locked && !pendingCalibration) ? 'none' : 'all',
                        cursor:
                          currentCalibration?.locked && !pendingCalibration
                            ? 'not-allowed'
                            : 'move',
                      }}
                      onPointerDown={(event) =>
                        startCalibrationHandleDrag(event, 'A')
                      }
                      onPointerMove={moveCalibrationHandle}
                      onPointerUp={endCalibrationHandleDrag}
                      onPointerCancel={endCalibrationHandleDrag}
                    />
                    <text
                      x={pointAHandle.x + 12}
                      y={pointAHandle.y - 10}
                      fontSize="13"
                      fontWeight="700"
                      fill="#b45309"
                      style={{ pointerEvents: 'none' }}
                    >
                      A
                    </text>
                  </>
                )}

                {pointBHandle && (
                  <>
                    <circle
                      cx={pointBHandle.x}
                      cy={pointBHandle.y}
                      r="9"
                      fill="#e11d48"
                      stroke="#ffffff"
                      strokeWidth="2"
                      style={{
                        pointerEvents: runMode || areaMode || countMode || (currentCalibration?.locked && !pendingCalibration) ? 'none' : 'all',
                        cursor:
                          currentCalibration?.locked && !pendingCalibration
                            ? 'not-allowed'
                            : 'move',
                      }}
                      onPointerDown={(event) =>
                        startCalibrationHandleDrag(event, 'B')
                      }
                      onPointerMove={moveCalibrationHandle}
                      onPointerUp={endCalibrationHandleDrag}
                      onPointerCancel={endCalibrationHandleDrag}
                    />
                    <text
                      x={pointBHandle.x + 12}
                      y={pointBHandle.y - 10}
                      fontSize="13"
                      fontWeight="700"
                      fill="#be123c"
                      style={{ pointerEvents: 'none' }}
                    >
                      B
                    </text>
                  </>
                )}
                </g>}
                {renderedLengths.filter((measurement) => measurement.visible).map((measurement) => (
                  <g key={measurement.id} opacity={measurementAppearance(measurement.groupId).opacity}>
                    {measurement.line && (
                      <>
                        <line
                          x1={measurement.line.x1}
                          y1={measurement.line.y1}
                          x2={measurement.line.x2}
                          y2={measurement.line.y2}
                          stroke={measurement.color}
                          strokeDasharray={measurement.doorHead ? '5 3' : undefined}
                          aria-label={measurement.doorHead ? 'Door head width ' + measurement.id : undefined}
                          strokeWidth={measurementAppearance(measurement.groupId).width}
                        />

                        {!(measurement.doorHead && overviewDrawing) && <g className={measurement.doorHead ? 'door-head-dimension' : 'length-dimension'}
                          transform={`translate(${
                            (measurement.line.x1 + measurement.line.x2) / 2
                          }, ${
                            (measurement.line.y1 + measurement.line.y2) / 2
                          })`}
                          style={{ pointerEvents: 'none' }}
                        >
                          <rect
                            x="-58"
                            y="-14"
                            width="116"
                            height="24"
                            rx="5"
                            fill="rgba(255,255,255,0.94)"
                            stroke={measurement.color}
                            strokeWidth="1"
                          />
                          <text
                            x="0"
                            y="3"
                            textAnchor="middle"
                            fontSize="12"
                            fontWeight="700"
                            fill={measurement.color}
                          >
                            {measurement.lengthMm !== null
                              ? `${sidebarTab==='groups' ? '' : measurement.id+' · '}${(measurement.lengthMm / 1000).toFixed(2)} m`
                              : sidebarTab==='groups' ? 'Check calibration' : `${measurement.id} · invalid`}
                          </text>
                        </g>}
                      </>
                    )}

                    {measurement.pointAHandle && (
                      <circle
                        cx={measurement.pointAHandle.x}
                        cy={measurement.pointAHandle.y}
                        r={measurement.locked ? 5 : 8}
                        fill={measurement.color}
                        stroke="#ffffff"
                        strokeWidth="2"
                        style={{
                          pointerEvents: measurement.locked || runMode || areaMode || countMode ? 'none' : 'all',
                          cursor: measurement.locked
                            ? 'default'
                            : lengthCalibrationValid
                            ? 'move'
                            : 'not-allowed',
                        }}
                        className={isSelectedPoint(measurement.id,0) ? 'selected-edit-point' : undefined} onContextMenu={(event)=>openPointMenu(event,measurement.id,'length',0)}
                        onPointerDown={(event) =>
                          startLengthHandleDrag(
                            event,
                            'A',
                            measurement.id
                          )
                        }
                        onPointerMove={moveLengthHandle}
                        onPointerUp={endLengthHandleDrag}
                        onPointerCancel={endLengthHandleDrag}
                      />
                    )}

                    {measurement.pointBHandle && (
                      <circle
                        cx={measurement.pointBHandle.x}
                        cy={measurement.pointBHandle.y}
                        r={measurement.locked ? 5 : 8}
                        fill={measurement.color}
                        stroke="#ffffff"
                        strokeWidth="2"
                        style={{
                          pointerEvents: measurement.locked || runMode || areaMode || countMode ? 'none' : 'all',
                          cursor: measurement.locked
                            ? 'default'
                            : lengthCalibrationValid
                            ? 'move'
                            : 'not-allowed',
                        }}
                        className={isSelectedPoint(measurement.id,1) ? 'selected-edit-point' : undefined} onContextMenu={(event)=>openPointMenu(event,measurement.id,'length',1)}
                        onPointerDown={(event) =>
                          startLengthHandleDrag(
                            event,
                            'B',
                            measurement.id
                          )
                        }
                        onPointerMove={moveLengthHandle}
                        onPointerUp={endLengthHandleDrag}
                        onPointerCancel={endLengthHandleDrag}
                      />
                    )}
                  </g>
                ))}

                {renderedRuns.map((run) => (
                  <g key={run.id} opacity={measurementAppearance(run.groupId).opacity}>
                    {run.handles.slice(1).map((end, i) => {
                      const start = run.handles[i]
                      return (
                        <g key={i}>
                          <line x1={start.x} y1={start.y} x2={end.x} y2={end.y}
                            stroke={run.color} strokeWidth={measurementAppearance(run.groupId).width} strokeDasharray={run.id === 'Draft' ? '7 4' : undefined} />
                          <text x={(start.x + end.x) / 2} y={(start.y + end.y) / 2 - 9}
                            className="run-label" textAnchor="middle" style={{ fill: run.color }}>
                            {sidebarTab==='groups' ? '' : run.id+'.'+(i+1)+' · '}{lengthCalibrationValid ? `${(run.segments[i] / 1000).toFixed(2)} m` : 'invalid'}
                          </text>
                        </g>
                      )
                    })}
                    {run.handles.map((point, i) => (
                      <circle key={i} cx={point.x} cy={point.y} r={run.locked ? 5 : 8}
                        fill={run.color} stroke="white" strokeWidth="2"
                        style={{
                          pointerEvents: !run.locked && lengthCalibrationValid && !hasDraft ? 'all' : 'none',
                          cursor: 'move',
                        }}
                        className={isSelectedPoint(run.id,i) ? 'selected-edit-point' : undefined} onContextMenu={(event)=>openPointMenu(event,run.id,'run',i)}
                      onPointerDown={(event) => startRunHandleDrag(event, run.id, i)}
                        onPointerMove={moveRunHandle} onPointerUp={endRunHandleDrag} onPointerCancel={endRunHandleDrag} />
                    ))}
                  </g>
                ))}

                {renderedCounts.map((count) => <g key={count.id} opacity={measurementAppearance(count.groupId).opacity}>
                  <path d={`M ${count.x - 8} ${count.y - 8} L ${count.x + 8} ${count.y + 8} M ${count.x + 8} ${count.y - 8} L ${count.x - 8} ${count.y + 8}`}
                    stroke={count.color} strokeWidth={measurementAppearance(count.groupId).width} />
                  <text x={count.x + 12} y={count.y - 10} className="run-label" style={{ fill: count.color }}>{sidebarTab==='groups' ? '' : count.id}</text>
                  <circle cx={count.x} cy={count.y} r="12" fill="transparent" style={{ pointerEvents: !count.locked && !hasDraft ? 'all' : 'none', cursor: 'move' }}
                    className={isSelectedPoint(count.id,0) ? 'selected-edit-point' : undefined} onContextMenu={(event)=>openPointMenu(event,count.id,'point',0)} onPointerDown={(event) => startCountHandleDrag(event, count.id)} onPointerMove={moveCountHandle} onPointerUp={endCountHandleDrag} onPointerCancel={endCountHandleDrag} />
                </g>)}

                {temporaryLengthAHandle && (
                  <>
                    <circle
                      cx={temporaryLengthAHandle.x}
                      cy={temporaryLengthAHandle.y}
                      r="9"
                      fill="#2563eb"
                      stroke="#ffffff"
                      strokeWidth="2"
                      style={{
                        pointerEvents: 'all',
                        cursor: 'move',
                      }}
                      onPointerDown={(event) =>
                        startLengthHandleDrag(event, 'A', null)
                      }
                      onPointerMove={moveLengthHandle}
                      onPointerUp={endLengthHandleDrag}
                      onPointerCancel={endLengthHandleDrag}
                    />
                    <text
                      x={temporaryLengthAHandle.x + 12}
                      y={temporaryLengthAHandle.y - 10}
                      fontSize="13"
                      fontWeight="700"
                      fill="#1d4ed8"
                      style={{ pointerEvents: 'none' }}
                    >
                      A
                    </text>
                  </>
                )}
                {snapPreview && snapEnabled && (lengthMode || runMode || areaMode || countMode || calibrationMode || readyToolKind) && (() => {
                  const [x,y]=viewportRef.current?.convertToViewportPoint(snapPreview.x,snapPreview.y) ?? [0,0]
                  return <g className="snap-preview" pointerEvents="none"><circle cx={x} cy={y} r="9" fill="white" stroke="#00a79d" strokeWidth="2" /><path d={snapPreview.kind === 'midpoint' ? `M ${x} ${y-5} L ${x+5} ${y+4} L ${x-5} ${y+4} Z` : `M ${x-4} ${y-4} h 8 v 8 h -8 Z`} fill="none" stroke="#007b74" strokeWidth="1.5" /><text x={x+15} y={y-12}>{snapPreview.source} · {snapPreview.kind === 'midpoint' ? 'Midpoint' : 'Endpoint'}</text></g>
                })()}
              </svg>
            </div>
          )}
          {pdf && <div className="drawing-footer" onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
            <div className={`drawing-scale-badge ${lengthCalibrationValid ? 'is-ready' : ''}`}><UiIcon name="lock" /><span>{lengthCalibrationValid ? 'Scale locked' : 'Calibration required'}</span></div>
            <span className="footer-zoom">{Math.round(scale * 100)}%</span>
            <div className="footer-page-controls">
              <button title="Previous drawing page" disabled={pageNumber <= 1 || runMode || areaMode} onClick={previousPage}>‹</button>
              <span>{drawingPageName(pageNumber)} · {pageNumber} / {pdf.numPages}</span>
              <button title="Next drawing page" disabled={pageNumber >= pdf.numPages || runMode || areaMode} onClick={nextPage}>›</button>
            </div>
            <span className="footer-help">Drag to pan <span>·</span> Scroll to zoom</span>
          </div>}
        </section>
        {sidebarTab==='rates' && ratesWorkspace('subcontractor')}
        {sidebarTab==='contractor-rates' && ratesWorkspace('contractor')}
        {sidebarTab==='summary' && summaryPresentation==='simplified' && simplifiedSummary()}
        {sidebarTab==='export' && <section className="summary-gallery export-workspace" aria-label="Export workspace"><header className="summary-gallery-heading"><h2>Export</h2></header><article className="material-order-card"><h3>Export options</h3><p>Export options will be added here.</p></article></section>}
        {sidebarTab==='materials' && materialSummary && <section className="summary-gallery materials-workspace" aria-label="Material quantities"><header className="summary-gallery-heading"><h2>Material Quantities</h2><strong className="material-scope-title">{materialScopeLabel}</strong><p>Exact quantities before waste · Final order rounded up to whole units.</p></header>{!pdf && <p>Import a drawing and measure some work to calculate materials.</p>}{materialSummary.issues.length>0 && <p className="materials-warning" role="status">Some quantities need checking. See the items listed on the left before ordering.</p>}{(wholePlotMaterials || materialSummary.boards.length>0) && <article className="material-order-card"><h3>Boards</h3>{materialSummary.boards.length ? materialsTable(materialSummary.boards,'Board quantities') : <p>No boards specified yet. Choose a board specification on each relevant measurement, or mark non-board work as Not applicable.</p>}</article>}{(wholePlotMaterials || materialSummary.rolls.length>0) && <article className="material-order-card"><h3>Insulation rolls</h3>{materialSummary.rolls.length ? materialsTable(materialSummary.rolls,'Insulation roll quantities') : <p>Choose an INS specification to calculate roll quantities.</p>}</article>}{(wholePlotMaterials || materialSummary.bags.length>0) && <article className="material-order-card"><h3>Adhesive & plaster</h3>{materialSummary.bags.length ? materialsTable(materialSummary.bags,'Adhesive and plaster quantities') : <p>Measure Dab or Skim work to calculate bag quantities.</p>}</article>}{!wholePlotMaterials && !materialSummary.boards.length && !materialSummary.rolls.length && !materialSummary.bags.length && <article className="material-order-card"><h3>No materials for this selection</h3><p>Check the measured work, material specifications and selected filters.</p></article>}<p className="length-note material-method-note">Matching specifications are combined before rounding. Insulation rolls use the coverage set on the left. Each material has its own waste allowance. Skim bags use the automatic skim totals and respect skim opt-outs. Board quantities are calculated from the original measurements only.</p></section>}
        {sidebarTab === 'summary' && summaryPresentation==='detailed' && <section className="summary-gallery plot-summary-gallery" aria-label="All drawings and page quantities">
          <header className="summary-gallery-heading"><h2>All Drawings — Page Breakdown</h2><p>Whole-plot totals are on the left. Each drawing below has its own measurements and quantities.</p></header>
          {!pdf && <p className="summary-empty">Import a drawing to see the page breakdown.</p>}
          {pdf && pageDrawingSummaries.map((page) => <article className="summary-page-card" key={page.number}>
            <header className="summary-page-heading"><div><h3>{page.name}</h3><p>Drawing {page.number} of {drawingPages.length} · {page.measurementCount} measured elements</p></div><button onClick={() => { goToDrawingPage(page.number); navigateWorkspace('measure') }}>Open drawing</button></header>
            <div className="summary-page-content">
              <SummaryDrawingPreview pdf={pdf} number={page.number} rotation={rotation} lengths={lengthMeasurements[page.number] ?? []} runs={runMeasurements[page.number] ?? []} areas={areaMeasurements[page.number] ?? []} counts={(countMeasurements[page.number] ?? []).map((item) => ({...item,previewColor:summaryColorFor(item.groupId,categories.find((category) => category.id === countCategoryId(item))?.color ?? '#dc2626')}))} colorFor={summaryColorFor} appearanceFor={measurementAppearance} preparePage={prepareSummaryPage} />
              <div className="summary-page-quantities"><h4>{page.name} quantities</h4>
                {page.needsCalibration && <p className="calibration-warning">Calibrate and lock this drawing to show complete quantities.</p>}
                {!page.rows.length && <p className="length-note">No measured work on this drawing yet.</p>}
                {page.rows.map((row,index) => <div className="summary-page-quantity" key={row.id}>
                  {(index===0 || summaryBlock(row)!==summaryBlock(page.rows[index-1])) && <h4 className="summary-trade-heading">{summaryBlock(row)}</h4>}
                  <h5><span className="work-legend-swatches">{row.colors.map((color) => <span className="work-legend-swatch" key={color} style={{background:color}} />)}</span>{row.name}</h5>
                  <div className="summary-page-values">{row.mode !== 'count' && <><strong>{row.totalAreaM2 === null ? 'Check calibration / heights' : row.totalAreaM2.toFixed(2) + ' m²'}</strong>{row.mode !== 'derived' && <span>{row.totalMm === null ? 'Check calibration' : (row.totalMm/1000).toFixed(2) + ' LM'}</span>}</>}{(row.mode === 'count' || row.count>0) && <strong>{row.count} no.</strong>}{row.id!=='__ungrouped__' && workPriceLabel(row)}</div>
                  {row.wallsWithoutHeight>0 && <p className="length-note">{row.wallsWithoutHeight} lengths/runs without height excluded from m².</p>}
                  {row.sourceNote && <p className="skim-source-note">{row.sourceNote}</p>}
                </div>)}
                {priceSubtotals(page.rows,page.name)}
              </div>
            </div>
          </article>)}
        </section>}
        {showingAllWork && <aside className="work-details-panel" aria-label="All Measured Work quantities" onKeyDown={(event) => {
          if (event.key === 'Escape') { event.stopPropagation(); setSelectedWorkId(null) }
        }}>
          <div className="work-details-header"><h2>All Measured Work — {drawingPageName(pageNumber)}</h2>
            <button aria-label="Close measured work overview" onClick={() => setSelectedWorkId(null)}>×</button>
          </div>
          <div className="work-details-body work-overview">
            {workOverviewRows.map((work) => <div className="work-overview-row" key={work.id}>
              <h3><span className="work-legend-swatches">{work.colors.map((color) => <span className="work-legend-swatch" key={color} style={{ background: color }} aria-label={work.name + ' drawing colour'} />)}</span>{work.name}</h3>
              <div className="work-overview-quantities">
                {work.mode !== 'count' && <>
                  <span>{work.totalAreaM2 === null ? 'Check calibration / height' : `${work.totalAreaM2.toFixed(2)} m²`}</span>
                  {work.mode !== 'derived' && <span>{work.totalMm === null ? 'Check calibration' : `${(work.totalMm / 1000).toFixed(2)} LM`}</span>}
                </>}
                {(work.mode === 'count' || work.count > 0) && <span>{work.count} no.</span>}
              </div>
              {work.sourceNote && <p className="skim-source-note">{work.sourceNote}</p>}
            </div>)}
            {!workOverviewRows.length && <p className="length-note">No measurements yet.</p>}
            <div className="workspace-tally"><span>Measured elements</span><strong>{allMeasurements.filter(item=>item.page===pageNumber).length}</strong><p>{drawingPageName(pageNumber)} only</p></div>
          </div>
        </aside>}
        {selectedWork && <aside className="work-details-panel" aria-label="Measured Work details" onKeyDown={(event) => {
          if (event.key === 'Escape') { event.stopPropagation(); setSelectedWorkId(null) }
        }}>
          <div className="work-details-header">
            <div><div className="work-details-eyebrow">{drawingPageName(pageNumber)} · THIS DRAWING ONLY</div><h2>{selectedWork.name || selectedWork.id}</h2></div>
            <button aria-label="Close measured work details" onClick={() => setSelectedWorkId(null)}>×</button>
          </div>
          <div className="work-details-body">
            <p className="work-category-name"><span className="category-swatch" style={{ background: categoryColor(selectedWork.id, '#64748b') }} />{categories.find((category) => category.id === selectedWork.categoryId)?.name || 'Uncategorised'}</p>
            <div className="work-quantity-summary" aria-live="polite">
              {categories.find((category) => category.id === selectedWork.categoryId)?.mode === 'count'
                ? <strong>{selectedWork.count} no.</strong> : <>
                  <strong>{selectedWork.totalAreaM2 === null ? 'Check calibration / heights' : `${selectedWork.totalAreaM2.toFixed(2)} m²`}</strong>
                  <strong>{selectedWork.totalMm === null ? 'Check calibration' : `${(selectedWork.totalMm / 1000).toFixed(2)} LM`}</strong>
                </>}
            </div>
            <p className="length-note">{selectedWork.members.length} measurements · quantities on {drawingPageName(pageNumber)} only</p>
            {selectedWork.invalidPages.length > 0 && <p className="calibration-warning">Calibrate and lock pages {selectedWork.invalidPages.join(', ')} to show complete totals.</p>}
            {selectedWork.wallsWithoutHeight > 0 && <p className="length-note">{selectedWork.wallsWithoutHeight} lengths/runs have no height and are excluded from m².</p>}
            {selectedWorkItems.some((item) => item.kind === 'wall') && (() => {
              const walls = selectedWorkItems.filter((item) => item.kind === 'wall')
              const heights = [...new Set(walls.map((item) => item.heightM))]
              const value = groupHeightDrafts[selectedWork.id + ':' + pageNumber] ?? (heights.length === 1 && heights[0] !== undefined ? String(heights[0]) : '')
              const invalid = value !== '' && (!Number.isFinite(Number(value)) || Number(value) <= 0)
              return <div className="work-height-editor"><label>Wall height on this drawing (mm)<input type="number" min="0.001" step="any" aria-label="Work wall height" aria-invalid={invalid} value={heightInMm(value)} placeholder={heights.length > 1 ? 'Mixed heights' : 'Add wall height'} onChange={(event) => setWorkWallHeight(selectedWork.id, heightFromMm(event.target.value), pageNumber)} /></label><p className="length-note">Applies to this work’s lengths/runs on this drawing only. You can also edit individual heights below.</p>{invalid && <p className="calibration-warning">Enter a height greater than zero, or clear it.</p>}</div>
            })()}
            {workBoardField(selectedWork.id,pageNumber)}
            <div className="work-visibility-actions">
              <button disabled={hasDraft} aria-pressed={viewGroupId === selectedWork.id} onClick={() => showOnlyMeasuredWork(selectedWork.id)}>Show Only This Measure on Drawing</button>
              <button disabled={hasDraft} onClick={showAllMeasurements}>Show All Measurements</button>
            </div>
            <fieldset className="work-appearance"><legend>Drawing appearance</legend>
              <label>Line thickness <output>{measurementAppearance(selectedWork.id).width} px</output><input aria-label="Line thickness" type="range" min="1" max="12" step="0.5" value={measurementAppearance(selectedWork.id).width} onChange={(event) => updateWorkAppearance(selectedWork.id, { width:Number(event.target.value) })} /></label>
              <label>Colour<input aria-label="Measurement colour" type="color" value={categoryColor(selectedWork.id, '#2563eb')} onChange={(event) => updateWorkAppearance(selectedWork.id, { color:event.target.value })} /></label>
              <label>Opacity <output>{Math.round(measurementAppearance(selectedWork.id).opacity*100)}%</output><input aria-label="Measurement opacity" type="range" min="15" max="100" value={measurementAppearance(selectedWork.id).opacity*100} onChange={(event) => updateWorkAppearance(selectedWork.id, { opacity:Number(event.target.value)/100 })} /></label>
              <button onClick={() => setGroups((current) => current.map((group) => group.id === selectedWork.id ? { ...group, appearance:undefined } : group))}>Reset appearance</button>
            </fieldset>
            <button className="duplicate-work-button" disabled={hasDraft} onClick={()=>requestDuplicate(selectedWorkItems.map(item=>item.id))}>Duplicate This Work</button><h3>Individual measurements</h3>{isolatedMeasurementId && <div className="isolation-notice">Showing {isolatedMeasurementId} only <button onClick={()=>{setIsolatedMeasurementId(null);setOverviewDrawing(false)}}>Show this work item</button></div>}
            <div className="work-member-list">
              {selectedWorkItems.map((item) => <details className="work-member-card" key={item.id}>
                <summary aria-label={'Show only '+(item.name || item.id)+' on drawing'} onClick={()=>{setIsolatedMeasurementId(item.id);setOverviewDrawing(false)}}><strong>{item.doorHead ? 'Door head · ' : ''}{item.name || item.id}</strong><span>{drawingPageName(item.page)} · {item.kind === 'count' ? '1 no.' : item.kind === 'area'
                  ? item.areaM2 === null ? 'Check calibration' : `${item.areaM2.toFixed(2)} m²`
                  : item.lengthMm === null ? 'Check calibration' : `${(item.lengthMm / 1000).toFixed(2)} m`}</span></summary>
                <p className="length-note">{item.id}{item.heightM !== undefined ? ` · height ${heightInMm(String(item.heightM))} mm` : ''}</p>
                {item.kind === 'wall' && item.heightM !== undefined && <strong>{item.areaM2 === null ? 'Check calibration / height' : `${item.areaM2.toFixed(2)} m²`}</strong>}
                <button className="wide-control" disabled={hasDraft} onClick={() => { setPageNumber(item.page); setViewMode('fit-page'); setPan({ x: 0, y: 0 }); setStageResizeTick((tick) => tick + 1) }}>Go to {drawingPageName(item.page)}</button>
                {item.page === pageNumber ? <>
                  {measurementDetails(item.id, item.name, item.groupId)}

                </> : <p className="length-note">Go to its page to edit its name or group.</p>}
                {item.kind === 'wall' && wallHeightField(item.id, item.heightM, item.lengthMm, item.page)}
              </details>)}
              {!selectedWorkItems.length && <p className="length-note">This work item has no measurements yet.</p>}
            </div>
            <details className="work-item-settings"><summary>Work item settings — all drawings</summary>
              <p className="length-note">The work item’s name and category apply across all drawings.</p>
              <label>Name<input value={selectedWork.name} maxLength={100} onChange={(event) => renameGroup(selectedWork.id, event.target.value)} /></label>
              <label>Category<select value={selectedWork.categoryId ?? ''} disabled={hasDraft} onChange={(event) => setGroupCategory(selectedWork.id, event.target.value)}>
                <option value="">Uncategorised</option>
                {categories.filter((category) => category.mode !== 'derived').map((category) => <option key={category.id} value={category.id}>{category.name || category.id}</option>)}
              </select></label>
              {categories.find((category) => category.id === selectedWork.categoryId)?.skimTarget && <label className="length-lock-control">
                <input type="checkbox" checked={selectedWork.includeSkim !== false} onChange={(event) => setGroups((current) => current.map((group) => group.id === selectedWork.id ? { ...group, includeSkim: event.target.checked } : group))} />Include area in skim
              </label>}
              <button className="remove-group-button" disabled={hasDraft} onClick={() => removeGroup(selectedWork.id)}>Remove work item — keep measurements</button>
            </details>
          </div>
        </aside>}
        {workMenu && groups.some((group) => group.id === workMenu.groupId) && <div className="measurement-context-menu work-context-menu" data-work-menu role="menu" aria-label="Measured Work actions" style={{left:workMenu.x,top:workMenu.y}} onContextMenu={(event) => event.preventDefault()}>
          <div className="context-menu-title">{groups.find((group) => group.id === workMenu.groupId)?.name || workMenu.groupId}<span>{workLockState(workMenu.groupId,workMenu.scopePage)} · {workMenu.scopePage === undefined ? 'All drawings' : drawingPageName(workMenu.scopePage)}</span></div>
          <button role="menuitem" autoFocus disabled={workLockState(workMenu.groupId,workMenu.scopePage) === 'empty'} onClick={() => workMenuAction('edit')}>Edit points</button>
          <button role="menuitem" disabled={workLockState(workMenu.groupId,workMenu.scopePage) === 'empty'} onClick={() => workMenuAction('lock')}>{workLockState(workMenu.groupId,workMenu.scopePage) === 'locked' ? 'Unlock all measurements' : 'Lock all measurements'}</button>
          <button role="menuitem" className="context-menu-delete" onClick={() => workMenuAction('delete')}>Delete selected measurements</button>
          <button role="menuitem" onClick={() => setWorkMenu(null)}>Close</button>
        </div>}
        {panelMenu && sidebarTab==='measure' && <div className="panel-context-menu" data-panel-menu role="menu" aria-label="Measurement panel actions" style={{left:panelMenu.x,top:panelMenu.y}}><button type="button" role="menuitem" autoFocus onClick={dockMeasurementPanel}>Dock</button><button type="button" role="menuitem" onClick={()=>setPanelMenu(null)}>Close</button></div>}
        {pageDeletePrompt && <div data-page-delete-prompt className="page-delete-prompt" role="alertdialog" aria-label="Delete drawing page" style={{left:pageDeletePrompt.x,top:pageDeletePrompt.y}}>
          <strong>Delete {pageDeletePrompt.name}?</strong><p>This removes this page and its measurements.</p><div><button className="delete-page-confirm" autoFocus onClick={confirmPageDelete}>Delete Page</button><button onClick={()=>setPageDeletePrompt(null)}>Cancel</button></div>
        </div>}
        {measurementMenu && contextItem && <div className="measurement-context-menu" data-measurement-menu role="menu" aria-label="Measurement actions" style={{left:measurementMenu.x,top:measurementMenu.y}} onContextMenu={(event) => event.preventDefault()}>
          <div className="context-menu-title">{contextItem.name || contextItem.id}<span>{contextItem.locked ? 'Locked' : 'Unlocked'}</span></div>
          <button role="menuitem" disabled={hasDraft} onClick={()=>requestDuplicate([measurementMenu.id])}>Duplicate Measurement</button>
          {hasDraft && <p>Finish the current measurement to edit this one.</p>}
          <button role="menuitem" autoFocus disabled={hasDraft || (measurementMenu.kind !== 'point' && !lengthCalibrationValid)} onClick={() => measurementMenuAction('edit')}>Edit points</button>
          <button role="menuitem" disabled={hasDraft} onClick={() => measurementMenuAction('lock')}>{contextItem.locked ? 'Unlock' : 'Lock'}</button>
          {measurementMenu.pointIndex!==undefined && <button role="menuitem" disabled={hasDraft || contextItem.locked || measurementMenu.kind==='length'} title={measurementMenu.kind==='length' ? 'A single length needs both endpoints' : 'Remove only this point'} onClick={()=>measurementMenuAction('delete-point')}>Delete Selected Point</button>}
          <button role="menuitem" className="context-menu-delete" disabled={hasDraft} onClick={() => measurementMenuAction('delete')}>Delete Entire Run/Measure</button>
          <button role="menuitem" onClick={() => setMeasurementMenu(null)}>Close</button>
        </div>}
      </main>
      {boardPickerOpen && <div className="board-spec-popover" data-board-picker role="dialog" aria-label="Board specification selector" style={{left:boardPosition.x,top:boardPosition.y,maxHeight:`calc(100dvh - ${boardPosition.y+8}px)`}} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeBoardPicker()}}}>
        <div className="board-picker-heading"><strong>Board Specification{boardTarget ? ' · '+('id' in boardTarget ? boardTarget.id : groups.find(group=>group.id===boardTarget.groupId)?.name || 'Selected work')+' · '+drawingPageName(boardTarget.page) : ''}</strong><button type="button" aria-label="Close board specification" onClick={closeBoardPicker}>✕</button></div>
        <div className="board-picker-breadcrumbs"><button type="button" onClick={()=>{setBoardStep('type');setBoardPendingSize(null);setBoardPendingSpec(null)}}>Board Spec</button>{boardStep!=='type' && <span>› {boardDraftType} › {boardStep==='size' ? 'Size' : 'Thickness'}</span>}</div>
        {boardStep==='type' && <div className="board-type-options">{boardTypes.map(type=><button type="button" key={type} onClick={()=>{setBoardDraftType(type);setBoardSizeReordering(false);setBoardDraftOverride(undefined);setBoardPendingSize(null);setBoardPendingSpec(null);setBoardStep(type==='THERMAL' ? 'size' : 'thickness')}}>{type}</button>)}</div>}
        {boardStep==='thickness' && <><h3>Thickness (mm)</h3>{(boardDraftType==='THERMAL' || boardDraftType==='CELO') && <p>1200 × 2400mm</p>}{boardDraftType==='INS' && <p>Roll coverage is set in Materials.</p>}<div className="board-thickness-options">{boardThicknessOptions(boardDraftType).map(thickness=><button type="button" key={thickness} onClick={()=>selectBoardThickness(thickness)}>{thickness}mm</button>)}</div></>}
        {boardStep==='size' && <><div className="board-size-heading"><h3>Size (mm)</h3>{boardDraftType!=='THERMAL' && <button type="button" aria-pressed={boardSizeReordering} onClick={()=>{setBoardSizeReordering(value=>!value);setBoardPendingSize(null);setBoardPendingSpec(null)}}>{boardSizeReordering ? 'Done' : 'Reorder'}</button>}</div>{boardDraftType!=='THERMAL' && <p>{boardDraftType} · {boardDraftThickness}mm</p>}<div className="board-size-options">{(boardDraftType==='THERMAL' ? [[1200,2400]] : orderedBoardSizes()).map(([width,length],index,list)=>{const height=boardPickerHeight(),blocked=!!height && height*1000>length+0.001;return <div className="board-size-row" key={width+'x'+length}><button type="button" aria-disabled={blocked} title={blocked ? 'Board length is shorter than the wall height. Override is available.' : undefined} onClick={()=>{if(!boardSizeReordering)selectBoardSize(width,length)}}>{width} × {length}mm{blocked && <small>Wall height too high · override available</small>}</button>{boardSizeReordering && boardDraftType!=='THERMAL' && <div className="board-size-order-actions"><button type="button" aria-label={'Move '+width+' × '+length+'mm up'} disabled={index===0} onClick={()=>moveBoardSize(width+'x'+length,-1)}>↑</button><button type="button" aria-label={'Move '+width+' × '+length+'mm down'} disabled={index===list.length-1} onClick={()=>moveBoardSize(width+'x'+length,1)}>↓</button></div>}</div>})}</div></>}
        {(boardPendingSize || boardPendingSpec) && <div className="board-height-warning" role="alert"><strong>Board length is shorter than the wall height.</strong><p>{boardPendingSpec?.lengthMm ?? boardPendingSize?.[1]}mm board · {Math.round((boardPickerHeight() ?? 0)*1000)}mm wall height.</p><button type="button" onClick={()=>{if(boardPendingSpec)completeBoardSpec(boardPendingSpec,true);else if(boardPendingSize)selectBoardSize(boardPendingSize[0],boardPendingSize[1],true)}}>Override and select anyway</button><button type="button" onClick={()=>{setBoardPendingSize(null);setBoardPendingSpec(null)}}>Choose another size</button></div>}
        <div className="board-picker-footer"><button type="button" onClick={()=>applyBoardChoice(null)}>Not applicable</button><button type="button" onClick={()=>applyBoardChoice(undefined)}>Clear selection</button></div>
      </div>}
      {newDescriptionOpen && <div className="measurement-dialog-backdrop" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setNewDescriptionOpen(false)}}}>
        <form className="measurement-dialog new-description-dialog" role="dialog" aria-modal="true" aria-labelledby="new-description-title" onSubmit={event=>{event.preventDefault();saveNewDescription()}}>
          <h2 id="new-description-title">Create New Work Description</h2>
          <label>Name<input autoFocus aria-label="New work description name" value={newDescriptionName} maxLength={100} onChange={event=>{setNewDescriptionName(event.target.value);setNewDescriptionError('')}} placeholder="e.g. Garage bulkhead" /></label>
          <label>Heading<select aria-label="New work description heading" value={newDescriptionHeading} onChange={event=>setNewDescriptionHeading(event.target.value as WorkHeading)}>{descriptionSections.map(section=><option key={section.title} value={section.title}>{section.title}</option>)}</select></label>
          <label>Type<select aria-label="New work description type" value={newDescriptionMode} onChange={event=>{const mode=event.target.value as 'measure'|'count';setNewDescriptionMode(mode);if(mode==='count')setNewDescriptionSkim('none')}}><option value="measure">Measure — lengths and areas</option><option value="count">Point — markers and quantity count</option></select></label>
          <label>Automatic skim<select aria-label="New work description skim" value={newDescriptionSkim} disabled={newDescriptionMode==='count'} onChange={event=>setNewDescriptionSkim(event.target.value as 'none'|'ceilings'|'walls')}><option value="none">Do not include in automatic skim</option><option value="ceilings">Include in Skimmed Ceilings</option><option value="walls">Include in Skimmed Walls</option></select></label>
          <p className="length-note">{newDescriptionMode==='count' ? 'Point markers count items and do not contribute to skim area.' : 'Automatic skim uses measured areas, or wall lengths with a height. It does not add another measurement.'}</p>
          {newDescriptionError && <p className="calibration-warning" role="alert">{newDescriptionError}</p>}
          <div className="dialog-actions"><button type="button" onClick={()=>setNewDescriptionOpen(false)}>Cancel</button><button type="submit" className="run-finish">Create New</button></div>
        </form></div>}
      {duplicateRequest && <div className="measurement-dialog-backdrop" onKeyDown={event=>{if(event.key==='Escape' && !duplicateBusyRef.current){event.stopPropagation();setDuplicateRequest(null)}}}>
        <form className="measurement-dialog duplicate-dialog" role="dialog" aria-modal="true" aria-labelledby="duplicate-title" aria-busy={duplicating} onSubmit={event=>{event.preventDefault();void confirmDuplicate()}}>
          <h2 id="duplicate-title">Duplicate Measurement</h2><p><strong>{duplicateRequest.title}</strong> · from {drawingPageName(duplicateRequest.page)}</p>
          <fieldset disabled={duplicating}><label>Copy to drawing<select autoFocus aria-label="Duplicate destination drawing" value={duplicatePage} onChange={event=>{setDuplicatePage(Number(event.target.value));setDuplicateError('')}}>{drawingPages.map((page,index)=><option key={index} value={index+1}>{page.name}{index+1===duplicateRequest.page ? ' (same page)' : ''}</option>)}</select></label>
          <label className="duplicate-description-choice"><input type="radio" name="copy-description" checked={duplicateKeepDescription} onChange={()=>setDuplicateKeepDescription(true)} />Keep Work Description — {categories.find(category=>category.id===duplicateRequest.categoryId)?.name || 'Ungrouped'}</label>
          <label className="duplicate-description-choice"><input type="radio" name="copy-description" checked={!duplicateKeepDescription} onChange={()=>setDuplicateKeepDescription(false)} />Change Work Description</label>
          {!duplicateKeepDescription && <label>Work Description<select aria-label="Duplicate work description" value={duplicateCategoryId} onChange={event=>setDuplicateCategoryId(event.target.value)}><option value="">Choose description</option>{categories.filter(category=>category.mode===(duplicateRequest.ids[0]?.startsWith('C') ? 'count' : 'measure')).map(category=><option key={category.id} value={category.id}>{category.name}</option>)}</select></label>}
          </fieldset><p className="length-note">Copies have their own IDs and are independently editable. Lengths, areas and heights are preserved using the destination page’s calibration. You can adjust their position afterwards.</p>
          {duplicateError && <p className="calibration-warning" role="alert">{duplicateError}</p>}<div className="dialog-actions"><button type="button" disabled={duplicating} onClick={()=>setDuplicateRequest(null)}>Cancel</button><button className="run-finish" type="submit" disabled={duplicating}>{duplicating ? 'Copying…' : 'Duplicate'}</button></div>
        </form></div>}
      {showCalibrationWarning && !duplicateRequest && !measurementChooser && !heightPromptOpen && <div className="calibration-notice-position" onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); setShowCalibrationWarning(false) }
      }}>
        <section className="calibration-notice calibration-warning-dialog" role="status" aria-live="polite"
          aria-labelledby="calibration-warning-title" aria-describedby="calibration-warning-description">
          <h2 id="calibration-warning-title">✕ Calibration required</h2>
          <p id="calibration-warning-description">{calibrationIssue === 'missing'
            ? `Page ${pageNumber} has not been calibrated. Set a known distance on the drawing before measuring.`
            : calibrationIssue === 'unlocked' ? 'The page calibration is unlocked. Lock it again before measuring.'
            : 'The calibration points have changed. Enter the new known distance and recalibrate before measuring.'}</p>
          <p>You can keep browsing pages. Calibrate this page when you are ready to measure.</p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setShowCalibrationWarning(false)}>Not Now</button>
            <button type="button" className="run-finish" onClick={reviewCalibration}>{calibrationIssue === 'missing' ? 'Calibrate Now' : 'Review Calibration'}</button>
          </div>
        </section>
      </div>}
      {measurementChooser && !heightPromptOpen && <div className="measurement-dialog-backdrop" onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); setMeasurementChooser(null) }
      }}>
        <form className="measurement-dialog" role="dialog" aria-modal="true" aria-labelledby="measurement-dialog-title"
          onSubmit={(event) => { event.preventDefault(); confirmMeasurement() }}>
          <h2 id="measurement-dialog-title">{measurementChooser === 'run' ? 'Start a wall run' : measurementChooser === 'area' ? 'Measure an area' : measurementChooser === 'point' ? 'Add point marks' : 'Measure a length'}</h2>
          <label>What are you measuring?
            <select autoFocus aria-label="Measurement category" value={chooserCategoryId} onChange={(event) => chooseMeasurementCategory(event.target.value)}>
              {categories.filter((category) => category.mode === (measurementChooser === 'point' ? 'count' : 'measure')).map((category) => <option key={category.id} value={category.id}>{category.name || category.id}</option>)}
            </select>
          </label>
          <p>Your measurement will be added to this category automatically.</p>
          <label>Custom/New Category<input maxLength={100} value={chooserGroupName} placeholder="Work not listed? Type a name" onChange={(event) => { setChooserGroupName(event.target.value); setChooserGroupId('__new__') }} /></label>
          <div className="dialog-actions"><button type="button" onClick={() => setMeasurementChooser(null)}>Cancel</button>
            <button className="run-finish" type="submit">Start Measuring</button></div>
        </form>
      </div>}
      {heightPromptOpen && <div className="measurement-dialog-backdrop" onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); setHeightPromptOpen(false); setMeasurementChooser(null) }
      }}>
        <form className="measurement-dialog" role="dialog" aria-modal="true" aria-labelledby="wall-height-prompt-title"
          onSubmit={(event) => { event.preventDefault(); confirmRunHeight() }}>
          <h2 id="wall-height-prompt-title">Add a wall height?</h2>
          <p>{categories.find((category) => category.id === chooserCategoryId)?.name}. Enter a height to calculate m² as you measure, or skip for length only.</p>
          <label>Wall height (mm)
            <input autoFocus type="number" min="0.001" step="any" inputMode="decimal" aria-label="Starting wall height" value={heightInMm(startingWallHeight)}
              placeholder="e.g. 2.4" onChange={(event) => setStartingWallHeight(heightFromMm(event.target.value))} />
          </label>
          {startingWallHeight !== '' && (!Number.isFinite(Number(startingWallHeight)) || Number(startingWallHeight) <= 0) && <p className="calibration-warning">Enter a height greater than zero, or choose Skip Height.</p>}
          <div className="dialog-actions">
            <button type="button" onClick={() => setHeightPromptOpen(false)}>Back</button>
            <button type="button" onClick={() => confirmRunHeight(true)}>Skip Height</button>
            <button className="run-finish" type="submit" disabled={startingWallHeight !== '' && (!Number.isFinite(Number(startingWallHeight)) || Number(startingWallHeight) <= 0)}>Start Measuring</button>
          </div>
        </form>
      </div>}
    </div>
  )
}
