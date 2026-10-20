import { useEffect, useMemo, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

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

type LengthMeasurement = {
  id: string
  name?: string
  groupId?: string
  heightM?: number
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
  // Shared corners keep adjacent segments connected when edited.
  points: Point[]
  locked: boolean
}

type MeasurementGroup = { id: string; name: string; categoryId?: string; includeSkim?: boolean; appearance?: { color?: string; width?: number; opacity?: number } }
type WorkCategory = { id: string; name: string; color: string; mode: 'measure' | 'count' | 'derived'; skimTarget?: 'walls' | 'ceilings' }
type CountMeasurement = { id: string; name?: string; groupId?: string; categoryId?: string; point: Point; locked: boolean }
type MeasurementKind = 'length' | 'run' | 'area' | 'point'

type UiIconName = 'file' | 'save' | 'import' | 'length' | 'run' | 'area' | 'point' | 'check' | 'work' | 'summary' | 'lock' | 'unlock' | 'mixed-lock'
const uiIconPaths: Record<UiIconName, string> = {
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
  lock: 'M7 10V7a5 5 0 0 1 10 0v3 M5 10h14v11H5z M12 14v3',
  unlock: 'M7 10V7a5 5 0 0 1 9-3 M5 10h14v11H5z M12 14v3',
  'mixed-lock': 'M7 10V7a5 5 0 0 1 10 0v3 M5 10h14v11H5z M9 16h6',
}
function UiIcon({ name, className = '' }: { name: UiIconName; className?: string }) {
  return <svg className={`ui-icon ${className}`} viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={uiIconPaths[name]} /></svg>
}

const initialCategories: WorkCategory[] = [
  { id: 'tack-ceiling', name: 'Tack Ceiling', color: '#2563eb', mode: 'measure', skimTarget: 'ceilings' },
  { id: 'tack-timber-wall', name: 'Tack Timber Wall', color: '#0f766e', mode: 'measure', skimTarget: 'walls' },
  { id: 'tack-metal-wall', name: 'Tack Metal Wall', color: '#7c3aed', mode: 'measure', skimTarget: 'walls' },
  { id: 'dabbed-external-wall', name: 'Dabbed External Wall', color: '#c2410c', mode: 'measure', skimTarget: 'walls' },
  { id: 'dabbed-internal-wall', name: 'Dabbed Internal Wall', color: '#be185d', mode: 'measure', skimTarget: 'walls' },
  { id: 'metal-studwork', name: 'Metal Studwork', color: '#475569', mode: 'measure' },
  { id: 'insulated-ceiling', name: 'Insulated Ceiling', color: '#a16207', mode: 'measure' },
  { id: 'insulated-wall', name: 'Insulated Wall', color: '#15803d', mode: 'measure' },
  { id: 'svp-boxing', name: 'SVP Boxing', color: '#dc2626', mode: 'count' },
  { id: 'skimmed-walls', name: 'Skimmed Walls', color: '#9333ea', mode: 'derived' },
  { id: 'skimmed-ceiling', name: 'Skimmed Ceiling', color: '#0369a1', mode: 'derived' },
]

type AreaMeasurement = {
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
  version: 6
  savedAt: string
  drawing: { name: string; pdfBase64: string; additionalPdfs?: Array<{ name: string; pdfBase64: string }>; pages?: DrawingPage[] }
  job: JobDetails
  calibrations: Record<number, Calibration>
  lengths: Record<number, LengthMeasurement[]>
  runs: Record<number, RunMeasurement[]>
  areas: Record<number, AreaMeasurement[]>
  counts: Record<number, CountMeasurement[]>
  categories: WorkCategory[]
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
  if (![1, 2, 3, 4, 5, 6].includes(value.version)) {
    throw new Error('This take-off uses a different file version. Open it with the version of the app that saved it.')
  }
  if (!object(value.drawing) || typeof value.drawing.name !== 'string' || !value.drawing.name.trim()
    || !isValidPdfBase64(value.drawing.pdfBase64)
    || typeof value.savedAt !== 'string' || !Number.isFinite(Date.parse(value.savedAt))) invalid()
  if (value.version === 6) {
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
      || (category.skimTarget !== undefined && (category.mode !== 'measure' || !['walls', 'ceilings'].includes(category.skimTarget)))) invalid()
    categoryIds.add(category.id)
  }
  // Built-in category IDs keep counting and automatic skim rules stable across saves.
  for (const required of initialCategories) {
    const category = categories.find((item) => item.id === required.id)
    if (!category || category.mode !== required.mode || category.skimTarget !== required.skimTarget) invalid()
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
  return { ...value, version: 6, drawing: { ...value.drawing, additionalPdfs: value.version === 6 ? value.drawing.additionalPdfs : [], pages: value.version === 6 ? value.drawing.pages : undefined }, groups, nextGroupNumber, areas, nextAreaNumber, categories, counts, nextCountNumber } as TakeoffFile
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
        const outputScale = Math.min(resolution.pixelRatio, Math.sqrt(16000000 / (view.width * view.height)), 8192 / Math.max(view.width, view.height))
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
      {lengths.map((item) => { const a=point(item.pointA), b=point(item.pointB); return <line key={item.id} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={colorFor(item.groupId,'#2563eb')} strokeWidth={appearanceFor(item.groupId).width} opacity={appearanceFor(item.groupId).opacity} /> })}
      {runs.map((item) => <polyline key={item.id} points={outline(item.points)} fill="none" stroke={colorFor(item.groupId,'#0f766e')} strokeWidth={appearanceFor(item.groupId).width} opacity={appearanceFor(item.groupId).opacity} />)}
      {counts.map((item) => { const [x,y]=point(item.point); return <path key={item.id} d={`M ${x-7} ${y-7} L ${x+7} ${y+7} M ${x+7} ${y-7} L ${x-7} ${y+7}`} stroke={item.previewColor ?? colorFor(item.groupId,'#dc2626')} strokeWidth={appearanceFor(item.groupId).width} opacity={appearanceFor(item.groupId).opacity} /> })}
    </svg>}
  </div>
}


export default function App() {
  useEffect(() => { document.title = 'Holmes QS' }, [])
  const [jobPanelOpen, setJobPanelOpen] = useState(false)
  const [toolboxOpen, setToolboxOpen] = useState(false)
  const [toolboxPosition, setToolboxPosition] = useState<Point>({ x: 310, y: 18 })
  const toolboxRef = useRef<HTMLDivElement | null>(null)
  const workspaceRef = useRef<HTMLElement | null>(null)
  const toolboxDragRef = useRef<{ id: number; x: number; y: number; origin: Point } | null>(null)
  const [snapEnabled, setSnapEnabled] = useState(false)
  const [snapSource, setSnapSource] = useState<'both' | 'pdf' | 'measure'>('both')
  const [snapEndpoints, setSnapEndpoints] = useState(true)
  const [snapMidpoints, setSnapMidpoints] = useState(true)
  const [snapPreview, setSnapPreview] = useState<SnapTarget | null>(null)
  const [pdfSnapInfo, setPdfSnapInfo] = useState('Import a drawing to use PDF snapping.')
  const pdfSnapCache = useRef<{ doc: PdfDoc | null; pages: Map<number, SnapIndex> }>({ doc: null, pages: new Map() })
  const [toolWallHeight, setToolWallHeight] = useState('')
  const [readyToolKind, setReadyToolKind] = useState<MeasurementKind | null>(null)
  const [overviewDrawing, setOverviewDrawing] = useState(false)
  const [groupHeightDrafts, setGroupHeightDrafts] = useState<Record<string, string>>({})
  const [workMenu, setWorkMenu] = useState<{ groupId: string; x: number; y: number; scopePage?: number } | null>(null)
  const [measurementMenu, setMeasurementMenu] = useState<{ id: string; kind: MeasurementKind; x: number; y: number } | null>(null)
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
  const [sidebarTab, setSidebarTab] = useState<'measure' | 'groups' | 'summary' | 'materials'>('measure')
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

  // View changes do not mark measurements as changed, but the view is saved too.
  const dataSignature = JSON.stringify({ job, drawingPages, calibrations, lengths: lengthMeasurements,
    runs: runMeasurements, nextLengthNumber: nextLengthNumberRef.current,
    nextRunNumber: nextRunNumberRef.current, groups, nextGroupNumber: nextGroupNumberRef.current,
    areas: areaMeasurements, nextAreaNumber: nextAreaNumberRef.current,
    counts: countMeasurements, nextCountNumber: nextCountNumberRef.current, categories })
  const hasDraft = runMode || lengthMode || areaMode || countMode || calibrationMode || !!pendingCalibration
  const hasUnsavedChanges = (savedSignature === null
    ? !!pdf || Object.values(job).some(Boolean)
    : savedSignature !== dataSignature) || hasDraft || hasInvalidHeight

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
    setSelectedWorkId(null)
    setReadyToolKind(null)
    setOverviewDrawing(false)
    setGroupHeightDrafts({})
    setMeasurementMenu(null)
    setWorkMenu(null)
    setToolCustomName('')
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
        format: 'drylining-takeoff', version: 6, savedAt,
        drawing: { name: fileName, pdfBase64: encodePdf(pdfBytesRef.current), additionalPdfs: drawingSources.slice(1).map((source) => ({ name: source.name, pdfBase64: encodePdf(source.bytes) })), pages: drawingPages },
        job: { ...job }, calibrations, lengths: lengthMeasurements, runs: runMeasurements,
        nextLengthNumber: nextLengthNumberRef.current, nextRunNumber: nextRunNumberRef.current,
        groups, nextGroupNumber: nextGroupNumberRef.current,
        areas: areaMeasurements, nextAreaNumber: nextAreaNumberRef.current,
        counts: countMeasurements, nextCountNumber: nextCountNumberRef.current, categories,
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
      setCountMeasurements(saved.counts)
      nextCountNumberRef.current = saved.nextCountNumber
      setHiddenGroupIds([])
      setShowUngrouped(true)
      setViewCategoryId(saved.view.categoryId ?? '')
      setViewGroupId(saved.view.groupId ?? '')
      setSidebarTab('measure')
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
        counts: saved.counts, nextCountNumber: saved.nextCountNumber, categories: saved.categories }))
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
    if (!pdf || fileBusyRef.current || number < 1 || number > drawingPages.length) return
    stopMeasurement()
    setPageNumber(number); setViewMode('fit-page'); setPan({ x: 0, y: 0 })
    if (sidebarTab === 'groups') {
      setSelectedWorkId('__all__'); setViewGroupId(''); setViewCategoryId(''); setHiddenGroupIds([]); setShowUngrouped(true); setOverviewDrawing(true)
    }
    setMeasurementMenu(null); setWorkMenu(null)
  }

  function deleteDrawingPage(number: number) {
    if (fileBusyRef.current || !drawingPages[number - 1]) return
    if (drawingPages.length <= 1) { setStatus('Keep at least one drawing page. Import another page before removing this one.'); return }
    if (hasDraft) { setStatus('Finish or stop measuring before deleting a drawing page.'); return }
    const members = [...(lengthMeasurements[number] ?? []), ...(runMeasurements[number] ?? []), ...(areaMeasurements[number] ?? []), ...(countMeasurements[number] ?? [])]
    if (!window.confirm(`Delete "${drawingPageName(number)}"? Its ${members.length} measurements and calibration will also be removed. Other pages will be kept.`)) return
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
    startToolMeasurement(kind)
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

    setPageNumber((current) => current - 1)
    setViewMode('fit-page')
    setPan({ x: 0, y: 0 })
  }

  function nextPage() {
    if (!pdf || pageNumber >= pdf.numPages || runMode || areaMode) return

    setPageNumber((current) => current + 1)
    setViewMode('fit-page')
    setPan({ x: 0, y: 0 })
  }

  function handleZoomSlider(value: string) {
    const percent = Number(value)

    if (!Number.isFinite(percent)) return

    setViewMode('manual')
    setScale(percent / 100)
  }

  function startPan(event: React.PointerEvent<HTMLElement>) {
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
    return snapForPoint(point) ?? point
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
  function previewSnap(event: React.PointerEvent<HTMLElement>) {
    if (!snapEnabled || panStartRef.current.active || !(lengthMode || runMode || areaMode || countMode || calibrationMode || readyToolKind)) { setSnapPreview(null); return }
    if (!drawingRef.current || !viewportRef.current) return
    const rect = drawingRef.current.getBoundingClientRect()
    const x=event.clientX-rect.left, y=event.clientY-rect.top
    if (x<0 || y<0 || x>rect.width || y>rect.height) { setSnapPreview(null); return }
    const [pdfX,pdfY]=viewportRef.current.convertToPdfPoint(x,y)
    setSnapPreview(snapForPoint({ x:pdfX, y:pdfY }))
  }
  useEffect(() => { setSnapPreview(null) }, [pdf, pageNumber, scale, rotation, snapEnabled, snapSource, snapEndpoints, snapMidpoints, lengthMode, runMode, areaMode, countMode, calibrationMode])

  function drawingPageName(number: number) { return drawingPages[number - 1]?.name || 'Page ' + number }

  function clampToolbox(position: Point): Point {
    const bounds=workspaceRef.current?.getBoundingClientRect()
    const box=toolboxRef.current?.getBoundingClientRect()
    if (!bounds || !box) return position
    return { x: Math.max(8, Math.min(position.x, bounds.width-box.width-8)), y: Math.max(8, Math.min(position.y, bounds.height-Math.min(box.height, bounds.height-16)-8)) }
  }
  useEffect(() => {
    if (!toolboxOpen || !workspaceRef.current) return
    const resize=() => setToolboxPosition((position) => { const next=clampToolbox(position); return next.x === position.x && next.y === position.y ? position : next })
    resize()
    const observer=new ResizeObserver(resize)
    observer.observe(workspaceRef.current)
    if (toolboxRef.current) observer.observe(toolboxRef.current)
    return () => observer.disconnect()
  }, [toolboxOpen])
  function startToolboxDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
    toolboxDragRef.current={ id:event.pointerId, x:event.clientX, y:event.clientY, origin:toolboxPosition }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  function moveToolboxDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag=toolboxDragRef.current
    if (!drag || drag.id !== event.pointerId) return
    setToolboxPosition(clampToolbox({ x:drag.origin.x+event.clientX-drag.x, y:drag.origin.y+event.clientY-drag.y }))
  }
  function endToolboxDrag(event: React.PointerEvent<HTMLDivElement>) {
    toolboxDragRef.current=null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

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

  function toolDestination(kind: MeasurementKind, categoryId: string, customName = toolCustomName) {
    const mode = kind === 'point' ? 'count' : 'measure'
    const name = customName.trim()
    let category = name ? categories.find((item) => item.mode === mode && item.name.trim().toLowerCase() === name.toLowerCase())
      : categories.find((item) => item.id === categoryId && item.mode === mode)
    if (!category && name) {
      let number = 1
      while (categories.some((item) => item.id === 'custom-' + number)) number++
      category = { id: 'custom-' + number, name, color: categories.find((item) => item.id === categoryId)?.color ?? '#0891b2', mode }
      const newCategory = category
      setCategories((current) => [...current, newCategory])
    }
    category ??= categories.find((item) => item.mode === mode)
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
    if (!pdf || queuedStart || !hasValidCalibration() || calibrationMode || pendingCalibration || toolHeightInvalid) return
    if (currentToolKind() === kind) return
    if (!finishToolBeforeSwitch()) return
    if (!toolDestination(kind, chooserCategoryId || activeCategory?.id || '')) return
    if (kind !== 'point') lastMeasureToolRef.current = kind
    setRunHeightM(toolWallHeight === '' ? undefined : Number(toolWallHeight))
    setQueuedStart(kind)
    setToolboxOpen(true)
  }

  function changeToolCategory(categoryId: string) {
    const category = categories.find((item) => item.id === categoryId && item.mode !== 'derived')
    if (!category) return
    const kind = currentToolKind()
    if (kind && ((kind === 'point') !== (category.mode === 'count'))) {
      if (!finishToolBeforeSwitch()) return
      const nextKind = category.mode === 'count' ? 'point' : lastMeasureToolRef.current
      toolDestination(nextKind, categoryId, '')
      setQueuedStart(nextKind)
    } else if (kind) {
      toolDestination(kind, categoryId, '')
      setToolSwitchNotice(countMode ? 'New point markers will use this category. Existing markers are unchanged.' : 'Current points kept; this measurement will use the selected category.')
    } else chooseMeasurementCategory(categoryId)
    setToolCustomName('')
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
    if (readyToolKind === 'point') { setCountMode(true); setReadyToolKind(null); revealActiveGroup() }
    if ((countMeasurements[pageNumber] ?? []).some((item) => countCategoryId(item) === activeCategory.id && Math.hypot(item.point.x - point.x, item.point.y - point.y) < 0.000001)) return
    const id = `C${String(nextCountNumberRef.current++).padStart(3, '0')}`
    setCountMeasurements((current) => ({ ...current,
      [pageNumber]: [...(current[pageNumber] ?? []), { id, point, locked: true, groupId: activeGroupId, categoryId: activeCategory.id }],
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
    countDragRef.current = { countId, pointerId: event.pointerId }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveCountHandle(event: React.PointerEvent<SVGCircleElement>) {
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
        id, points: [...areaPoints], locked: true, ...(activeGroupId ? { groupId: activeGroupId } : {}),
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
    areaDragRef.current = { areaId, pointIndex, pointerId: event.pointerId }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveAreaHandle(event: React.PointerEvent<SVGCircleElement>) {
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
    const invalid = text !== '' && (!Number.isFinite(Number(text)) || Number(text) <= 0)
    return (
      <div className="wall-height-field">
        <label>
          Wall height (m, optional)
          <input type="number" min="0.001" step="any" inputMode="decimal" value={text}
            placeholder="e.g. 2.4" aria-label={`Wall height for ${id}`} aria-invalid={invalid}
            onChange={(event) => setWallHeight(id, event.target.value, measurementPage)} />
        </label>
        {invalid ? <p className="calibration-warning">Enter a height greater than zero, or clear the field.</p>
          : heightM !== undefined ? <>
            <div className="wall-area-result">{lengthMm === null ? 'Calibration required' : `${((lengthMm / 1000) * heightM).toFixed(2)} m²`}</div>
            <p className="length-note">{lengthMm === null ? '' : `${(lengthMm / 1000).toFixed(2)} m × ${heightM} m · `}One face, before deductions.</p>
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

  function updateMeasurementDetails(id: string, details: { name?: string; groupId?: string; heightM?: number }, measurementPage = pageNumber) {
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

  function measurementDetails(id: string, name = '', groupId = '') {
    return (
      <div className="measurement-details">
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
        id, points: [...runPoints], locked: true, ...(activeGroupId ? { groupId: activeGroupId } : {}),
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
    runDragRef.current = { runId, pointIndex, pointerId: event.pointerId }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveRunHandle(event: React.PointerEvent<SVGCircleElement>) {
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
    setReadyToolKind(null)
    setLengthMode(false)
    setLengthPoints([])
    setStatus('Length measurement cancelled.')
  }

  function addLengthPoint(clientX: number, clientY: number) {
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
    const id = `L${String(nextLengthNumberRef.current).padStart(3, '0')}`
    nextLengthNumberRef.current += 1

    setLengthMeasurements((current) => ({
      ...current,
      [pageNumber]: [
        ...(current[pageNumber] ?? []),
        { id, pointA, pointB, locked: true, ...(runHeightM !== undefined ? { heightM: runHeightM } : {}), ...(activeGroupId ? { groupId: activeGroupId } : {}) },
      ],
    }))

    setLengthPoints([])
    setLengthMode(false)
    setReadyToolKind('length')
    setStatus(
      `${id} measured and locked. Untick Lock if you want to fine-tune its end points.`
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
    if (!pdf || sidebarTab === 'summary' || viewMode !== 'fit-page') return

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
    if (!pdf || sidebarTab === 'summary' || !canvasRef.current) return

    const document = pdf
    let disposed = false

    async function renderPage() {
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

      const context = canvas.getContext('2d')
      if (!context) return

      const outputScale = window.devicePixelRatio || 1

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
          console.error(error)
        }
      }
    }

    renderPage()

    return () => {
      disposed = true

      try {
        renderTaskRef.current?.cancel()
      } catch {
        // Ignore cancellation errors during cleanup.
      }
    }
  }, [pdf, pageNumber, scale, rotation, sidebarTab])

  const currentCalibration = calibrations[pageNumber]

  const lineSource =
    currentCalibration ??
    (pendingCalibration
      ? {
          pointA: pendingCalibration.pointA,
          pointB: pendingCalibration.pointB,
        }
      : null)

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

  const handleSourceA =
    currentCalibration?.pointA ??
    pendingCalibration?.pointA ??
    (calibrationPoints.length >= 1 ? calibrationPoints[0] : null)

  const handleSourceB =
    currentCalibration?.pointB ??
    pendingCalibration?.pointB ??
    (calibrationPoints.length >= 2 ? calibrationPoints[1] : null)

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
  const allMeasurements: Array<{ id: string; name?: string; groupId?: string; categoryId?: string; page: number; pdfLength: number; pdfArea: number; heightM?: number; kind: 'wall' | 'area' | 'count' }> = [
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
      sum + (item.kind === 'count' ? 0 : item.pdfLength * calibrations[item.page].mmPerPdfUnit), 0)
    const invalidHeightIds = members.filter((item) => {
      const text = heightDrafts[item.id]
      return item.kind === 'wall' && text !== undefined && text !== '' && (!Number.isFinite(Number(text)) || Number(text) <= 0)
    }).map((item) => item.id)
    const totalAreaM2 = invalidPages.length || invalidHeightIds.length ? null : members.reduce((sum, item) => {
      if (item.kind === 'count') return sum
      const mmPerUnit = calibrations[item.page].mmPerPdfUnit
      return sum + (item.kind === 'area' ? item.pdfArea * mmPerUnit ** 2 / 1000000
        : item.heightM === undefined ? 0 : item.pdfLength * mmPerUnit / 1000 * item.heightM)
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
      : item.heightM !== undefined ? item.pdfLength * calibration.mmPerPdfUnit / 1000 * item.heightM : null
    return { ...item, lengthMm, areaM2 }
  }
  const viewItems = allMeasurements.filter((item) => matchesViewCategory(item.groupId, item.categoryId, item.kind === 'wall', item.heightM)).map(withQuantities)
  const selectedWorkItems = allMeasurements.filter((item) => item.groupId === selectedWorkId && item.page === pageNumber).map(withQuantities)
  const ungroupedItems = allMeasurements.filter((item) => !item.groupId).map(withQuantities)
  const ungroupedGeometry = ungroupedItems.filter((item) => item.kind !== 'count')
  const workOverviewRows = [
    ...groupSummaries.map((group) => ({ id: group.id, name: group.name || group.id,
      mode: categories.find((category) => category.id === group.categoryId)?.mode ?? 'measure',
      totalMm: group.totalMm, totalAreaM2: group.totalAreaM2, count: group.count, colors: [categoryColor(group.id, '#64748b')], sourceNote: '' })),
    ...(ungroupedItems.length ? [{ id: '__ungrouped__', name: 'Ungrouped Measurements', mode: 'mixed', sourceNote: '', colors: [...new Set(ungroupedItems.map((item) => item.kind === 'count' ? categories.find((category) => category.id === item.categoryId)?.color ?? '#dc2626' : item.kind === 'area' ? '#c2410c' : item.id.startsWith('R') ? '#0f766e' : '#2563eb'))],
      totalMm: ungroupedGeometry.some((item) => item.lengthMm === null) ? null : ungroupedGeometry.reduce((sum, item) => sum + (item.lengthMm ?? 0), 0),
      totalAreaM2: ungroupedGeometry.some((item) => item.kind === 'area' || item.heightM !== undefined ? item.areaM2 === null : false) ? null
        : ungroupedGeometry.reduce((sum, item) => sum + (item.areaM2 ?? 0), 0),
      count: ungroupedItems.filter((item) => item.kind === 'count').length }] : []),
    ...measuredCategorySummaries.filter((category) => category.mode === 'derived').map((category) => ({
      id: category.id, name: category.name, mode: 'derived', totalMm: 0, totalAreaM2: category.totalAreaM2, count: 0,
      colors: [...new Set(category.sourceGroups.filter((group) => group.members.some((item) => item.kind === 'area' || item.heightM !== undefined)).map((group) => categoryColor(group.id, category.color)))],
      sourceNote: 'N.B. Calculated from ' + category.sourceGroups.filter((group) => group.members.some((item) => item.kind === 'area' || item.heightM !== undefined)).map((group) => (group.name || group.id) + ' (' + (categories.find((item) => item.id === group.categoryId)?.name ?? 'Uncategorised') + ')').join(', ') + '. Uses those measured areas; no additional drawing measurement. Groups opted out of skim are excluded.'
    })),

  ]
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
      totalMm:geometry.some((item) => item.lengthMm === null) ? null : geometry.reduce((sum,item) => sum+(item.lengthMm ?? 0),0),
      totalAreaM2:geometry.some((item) => (item.kind === 'area' || item.heightM !== undefined) && item.areaM2 === null) ? null : geometry.reduce((sum,item) => sum+(item.areaM2 ?? 0),0),
      count:0, colors:[...new Set(ungrouped.map((item) => item.kind === 'area' ? '#c2410c' : item.id.startsWith('R') ? '#0f766e' : '#2563eb'))], sourceNote:'Not assigned to a work category.', wallsWithoutHeight:geometry.filter((item) => item.kind === 'wall' && item.heightM === undefined).length })
    const calibration=calibrations[number]
    return { number, name:drawingPageName(number), rows, measurementCount:members.length,
      needsCalibration:members.some((item) => item.kind !== 'count') && (!calibration || !calibration.locked || calibration.needsRecalibration) }
  }
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
  const renderedCounts = currentCounts.filter((item) => isMeasurementVisible(item.groupId, countCategoryId(item))).map((item) => {
    const [x, y] = viewportRef.current?.convertToViewportPoint(item.point.x, item.point.y) ?? [0, 0]
    return { ...item, x, y, color: categoryColor(item.groupId, categories.find((category) => category.id === countCategoryId(item))?.color ?? '#dc2626') }
  })
  const currentAreas = areaMeasurements[pageNumber] ?? []
  const draftAreaProblem = polygonProblem(areaPoints)
  const draftAreaM2 = lengthCalibrationValid && !draftAreaProblem
    ? polygonArea(areaPoints) * currentCalibration.mmPerPdfUnit ** 2 / 1000000 : null
  const renderedAreas = [...currentAreas.filter((area) => isMeasurementVisible(area.groupId)), ...(areaMode ? [{ id: 'Draft area', points: areaPoints, locked: true, groupId: activeGroupId || undefined }] : [])].map((area) => ({
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
    ...currentRuns.filter((run) => isMeasurementVisible(run.groupId, undefined, true, run.heightM)),
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
      visible: isMeasurementVisible(measurement.groupId, undefined, true, measurement.heightM),
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


  function openMeasurementMenu(event: React.MouseEvent<HTMLElement>) {
    const drawing = drawingRef.current
    if (!drawing) return
    const rect = drawing.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top
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

  function measurementMenuAction(action: 'edit' | 'lock' | 'delete') {
    if (!measurementMenu || !contextItem) return
    if (hasDraft) { setStatus('Finish or cancel the current measurement before editing a saved one.'); return }
    const { id, kind } = measurementMenu
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
    <div className="app-shell" aria-busy={isFileBusy}>
      <header className="topbar" inert={isFileBusy || !!measurementChooser || heightPromptOpen}>
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
          <button aria-pressed={toolboxOpen} onClick={() => { setSidebarTab('measure'); setSelectedWorkId(null); setToolboxOpen(true) }}><UiIcon name="length" />Measure</button>
          <button aria-pressed={sidebarTab === 'groups'} onClick={() => navigateWorkspace('groups')}><UiIcon name="work" />Measured Work</button>
          <button aria-pressed={sidebarTab === 'summary'} onClick={() => navigateWorkspace('summary')}><UiIcon name="summary" />Summary</button>
          <button aria-pressed={sidebarTab === 'materials'} onClick={() => navigateWorkspace('materials')}><UiIcon name="work" />Materials</button>
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

      <main ref={workspaceRef} className={`workspace ${sidebarTab === 'summary' ? 'is-summary' : ''} ${selectedWork || showingAllWork ? 'has-work-details' : ''}`} inert={isFileBusy || !!measurementChooser || heightPromptOpen}>
          <div hidden={!toolboxOpen} ref={toolboxRef} className="measure-toolbox floating-toolbox" role="region" aria-label="Movable measurement toolbox" style={{ left: toolboxPosition.x, top: toolboxPosition.y, maxWidth: `calc(100% - ${toolboxPosition.x + 8}px)`, maxHeight: `calc(100% - ${toolboxPosition.y + 8}px)` }} onWheel={(event) => event.stopPropagation()}>
          <div className="toolbox-heading toolbox-drag-handle" tabIndex={0} aria-label="Move measurement toolbox with arrow keys" onPointerDown={startToolboxDrag} onPointerMove={moveToolboxDrag} onPointerUp={endToolboxDrag} onPointerCancel={endToolboxDrag} onKeyDown={(event) => {
            const delta: Record<string, Point> = { ArrowLeft:{x:-20,y:0}, ArrowRight:{x:20,y:0}, ArrowUp:{x:0,y:-20}, ArrowDown:{x:0,y:20} }
            if (event.target === event.currentTarget && delta[event.key]) { event.preventDefault(); setToolboxPosition((p) => clampToolbox({ x:p.x+delta[event.key].x, y:p.y+delta[event.key].y })) }
          }}><span className="drag-grip" aria-hidden="true">⠿</span><h2>Measure</h2><button aria-label="Close measurement toolbox" onClick={closeMeasureToolbox}>×</button></div>
          <div className="toolbox-body">
          <div className="tool-selector-grid" aria-label="Measurement tools">
            <button className="tool-tile" title={(!lengthCalibrationValid || calibrationMode || pendingCalibration) ? measurementToolHelp() : undefined} onMouseEnter={() => { if (!lengthCalibrationValid || calibrationMode || pendingCalibration) setToolCalibrationNotice(measurementToolHelp()) }} onFocus={() => { if (!lengthCalibrationValid || calibrationMode || pendingCalibration) setToolCalibrationNotice(measurementToolHelp()) }} aria-pressed={lengthMode || readyToolKind === 'length'} aria-disabled={calibrationMode || !!pendingCalibration || !lengthCalibrationValid}
              onClick={() => activateMeasurementTool('length')}>
              <UiIcon name="length" /><span>{'Single Length'}</span>
            </button>
            <button className="tool-tile" title={(!lengthCalibrationValid || calibrationMode || pendingCalibration) ? measurementToolHelp() : undefined} onMouseEnter={() => { if (!lengthCalibrationValid || calibrationMode || pendingCalibration) setToolCalibrationNotice(measurementToolHelp()) }} onFocus={() => { if (!lengthCalibrationValid || calibrationMode || pendingCalibration) setToolCalibrationNotice(measurementToolHelp()) }} aria-pressed={runMode || readyToolKind === 'run'} aria-disabled={!lengthCalibrationValid || calibrationMode || !!pendingCalibration}
              onClick={() => activateMeasurementTool('run')}><UiIcon name="run" /><span>Multiple Length</span></button>
            <button className="tool-tile" title={(!lengthCalibrationValid || calibrationMode || pendingCalibration) ? measurementToolHelp() : undefined} onMouseEnter={() => { if (!lengthCalibrationValid || calibrationMode || pendingCalibration) setToolCalibrationNotice(measurementToolHelp()) }} onFocus={() => { if (!lengthCalibrationValid || calibrationMode || pendingCalibration) setToolCalibrationNotice(measurementToolHelp()) }} aria-pressed={areaMode || readyToolKind === 'area'} aria-disabled={!lengthCalibrationValid || calibrationMode || !!pendingCalibration}
              onClick={() => activateMeasurementTool('area')}><UiIcon name="area" /><span>Area</span></button>
            <button className="tool-tile" title={(!lengthCalibrationValid || calibrationMode || pendingCalibration) ? measurementToolHelp() : undefined} onMouseEnter={() => { if (!lengthCalibrationValid || calibrationMode || pendingCalibration) setToolCalibrationNotice(measurementToolHelp()) }} onFocus={() => { if (!lengthCalibrationValid || calibrationMode || pendingCalibration) setToolCalibrationNotice(measurementToolHelp()) }} aria-pressed={countMode || readyToolKind === 'point'} aria-disabled={!lengthCalibrationValid || calibrationMode || !!pendingCalibration}
              onClick={() => activateMeasurementTool('point')}><UiIcon name="point" /><span>Point Marker</span></button>
          </div>

          {toolCalibrationNotice && <p className="tool-calibration-help" role="status">{toolCalibrationNotice}</p>}
          <label className="toolbox-category">Work category<select value={chooserCategoryId || activeCategory?.id || 'tack-ceiling'} onChange={(event) => changeToolCategory(event.target.value)}>
            {categories.filter((category) => category.mode !== 'derived').map((category) => <option key={category.id} value={category.id}>{category.name || category.id}</option>)}
          </select></label>
          <label className="toolbox-custom">Custom/New Category
            <input aria-label="Custom measurement name" value={toolCustomName} maxLength={100} placeholder="Work not listed? Type a name" onChange={(event) => setToolCustomName(event.target.value)} onBlur={applyToolCustomName} onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); applyToolCustomName() }
            }} />
          </label>
          {toolSwitchNotice && <p className="tool-switch-notice" role="status">{toolSwitchNotice}</p>}
          <label className="toolbox-height">Wall height (optional)<div><input type="number" min="0.001" step="0.01" inputMode="decimal" aria-label="Toolbox wall height" value={toolWallHeight} disabled={areaMode || countMode} onChange={(event) => {
            const value=event.target.value; setToolWallHeight(value)
            if (value === '' || (Number.isFinite(Number(value)) && Number(value)>0)) setRunHeightM(value === '' ? undefined : Number(value))
          }} /><span>m</span></div></label>
          {toolHeightInvalid && <p className="calibration-warning">Enter a height greater than zero, or leave it blank.</p>}
          <div className="snap-controls">
            <label className="snap-toggle"><input type="checkbox" checked={snapEnabled} onChange={(event) => setSnapEnabled(event.target.checked)} />Snap to lines<span>{snapEnabled ? 'On' : 'Off'}</span></label>
            {snapEnabled && <div className="snap-options">
              <label>Snap to<select value={snapSource} onChange={(event) => setSnapSource(event.target.value as 'both' | 'pdf' | 'measure')}><option value="both">PDF + measurements</option><option value="pdf">PDF lines</option><option value="measure">Measurement lines</option></select></label>
              <div className="snap-point-options"><label><input type="checkbox" checked={snapEndpoints} onChange={(event) => setSnapEndpoints(event.target.checked)} />Start / end</label><label><input type="checkbox" checked={snapMidpoints} onChange={(event) => setSnapMidpoints(event.target.checked)} />Midpoints</label></div>
              <p className="length-note">{snapSource === 'measure' ? 'Snaps to visible measurements on this page.' : pdfSnapInfo}</p>
              {!snapEndpoints && !snapMidpoints && <p className="length-note">Choose a point type to enable snapping.</p>}
            </div>}
          </div>
          {readyToolKind && <div className="ready-tool-banner" role="status"><strong>Ready for the next {readyToolKind === 'point' ? 'point marker' : readyToolKind === 'length' ? 'length' : readyToolKind}.</strong><div>{activeGroup?.name || activeCategory?.name} · click a new start point.</div></div>}
          {(lengthMode || runMode || areaMode || countMode) && <div className="measuring-banner" role="status">
            <strong>{activeCategory?.name || 'Uncategorised'}</strong>
            <div>{activeGroup?.name || 'Ungrouped'} · {lengthMode ? lengthPoints.length ? 'Click the second point to finish' : 'Click the start point' : 'Press Enter to finish'}</div>
          </div>}



          {lengthMode && <button className="wide-control" onClick={cancelLengthMeasurement}>Cancel Length</button>}
          {runMode && (
            <div className="run-panel" aria-label="Current run">
              <strong>Run in progress</strong>
              <div className="length-primary" aria-live="polite">
                {(draftTotalMm / 1000).toFixed(2)} m
              </div>
              <div>{draftSegments.length} segment{draftSegments.length === 1 ? '' : 's'}</div>
              {runHeightM !== undefined && <div className="wall-area-result">{(draftTotalMm / 1000 * runHeightM).toFixed(2)} m² · height {runHeightM} m</div>}
              <p className="length-note">
                {runPoints.length === 0 ? 'Click your start point on the drawing.' : 'Click the next wall corner, then keep going. Drag to pan; use the wheel to zoom.'}
              </p>
              <button className="run-finish" disabled={runPoints.length < 2 || !lengthCalibrationValid || toolHeightInvalid} onClick={() => finishRun()}>
                Finish Run
              </button>
              <div className="run-actions">
                <button disabled={runPoints.length === 0} onClick={() => setRunPoints((points) => points.slice(0, -1))}>
                  Undo Last Point
                </button>
                <button onClick={cancelRun}>Cancel Run</button>
              </div>
              <p className="length-note">Finish or cancel before changing page or calibration.</p>
            </div>
          )}

          {areaMode && (
            <div className="area-panel" aria-label="Current area">
              <strong>Area in progress · {areaPoints.length} corners</strong>
              <div className="area-primary" aria-live="polite">{draftAreaM2 === null ? '— m²' : `${draftAreaM2.toFixed(2)} m² so far`}</div>
              <p className="length-note">Click around the outside of the shape. Finish Area joins the last corner to the first. Drag to pan; use the wheel to zoom.</p>
              {areaPoints.length >= 3 && draftAreaProblem && <p className="calibration-warning">{draftAreaProblem}</p>}
              <button className="area-finish" onClick={finishArea} disabled={!!draftAreaProblem || !lengthCalibrationValid}>Finish Area</button>
              <div className="run-actions">
                <button disabled={!areaPoints.length} onClick={() => setAreaPoints((points) => points.slice(0, -1))}>Undo Last Point</button>
                <button onClick={cancelArea}>Cancel Area</button>
              </div>
              <p className="length-note">Finish or cancel before changing page, calibration or group.</p>
            </div>
          )}
          {countMode && <div className="count-panel">
            <strong>{activeCategory?.name || 'Point marks'}</strong>
            <p>Click once at each location. Each cross counts as one. Press Enter or Done Marking to finish.</p>
            <button className="wide-control" onClick={finishCounting}>Done Marking</button>
          </div>}
          </div>


          </div>
        <aside className="sidebar">
          <div className="sidebar-fixed">
          <nav className="sidebar-tabs" aria-label="Take-off sections">
            {(['measure', 'groups', 'summary'] as const).map((tab) => <button key={tab}
              aria-pressed={sidebarTab === tab} onClick={() => { navigateWorkspace(tab); if (tab === 'measure') setToolboxOpen(true) }}>
              <UiIcon name={tab === 'measure' ? 'length' : tab === 'groups' ? 'work' : 'summary'} />
              <span>{tab === 'measure' ? 'New Measure' : tab === 'groups' ? 'Measured Work' : 'Summary'}</span>
            </button>)}
          </nav>
          <section ref={calibrationDockRef} className={`calibration-dock ${!pdf ? 'calibration-empty' : lengthCalibrationValid ? 'calibration-ready' : 'calibration-not-ready'}`} aria-label="Page calibration">
            <div className="calibration-readiness" role="status">
              <span aria-hidden="true">{!pdf ? '○' : lengthCalibrationValid ? '✓' : '✕'}</span>
              <div><strong>{!pdf ? 'Import a drawing to begin' : lengthCalibrationValid ? 'Set up and ready' : 'Calibration required'}</strong>
                <div>{!pdf ? 'Use Import New Drawing above.' : lengthCalibrationValid ? `Page ${pageNumber} calibrated and locked.` : calibrationIssue === 'unlocked' ? 'Calibration is unlocked. Lock it before measuring.' : calibrationIssue === 'changed' ? 'Calibration points changed. Recalibrate before measuring.' : `Page ${pageNumber} needs calibration before measuring.`}</div>
              </div>
            </div>
            <details className="calibration-dock-tools" open={!!pdf && (!lengthCalibrationValid || calibrationMode || !!pendingCalibration)}>
              <summary>Calibration tools</summary>
          {!lengthCalibrationValid && pdf && <p className="calibration-first-note">
            {!currentCalibration ? 'Calibrate your drawing to enable measurement tools.' : currentCalibration.needsRecalibration ? 'Update the calibration below to enable measurement tools.' : 'Lock the calibration below to enable measurement tools.'}
          </p>}
          <button
            className={`future-tool ${calibrationAttention ? 'calibrate-attention' : ''}`}
            disabled={!pdf || runMode || areaMode || countMode}
            onClick={calibrationMode ? cancelCalibration : startCalibration}
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
              ) : currentCalibration.locked ? (
                <button onClick={unlockCalibration} disabled={runMode || areaMode || countMode}>
                  Unlock Calibration
                </button>
              ) : (
                <>
                  <div className="calibration-note">
                    Drag point A or B to fine-tune its position.
                  </div>

                  <button onClick={lockCalibration}>
                    Lock Calibration
                  </button>
                </>
              )}

              <button
                className="secondary-calibration-button"
                onClick={clearCalibration}
                disabled={runMode || areaMode || countMode}
              >
                Clear Calibration
              </button>
            </div>
          )}


            </details>
          </section>
          </div>
          <div className="sidebar-scroll">

          <div className={`save-status ${hasUnsavedChanges ? 'unsaved' : ''}`} role="status">
            <strong>{isFileBusy ? 'Opening file…' : hasUnsavedChanges ? 'Changes not saved' : lastSavedAt ? 'Saved file loaded / downloaded' : 'Start a new take-off'}</strong>
            <p>{hasInvalidHeight ? 'Correct or clear the invalid wall height before saving.' : hasDraft ? 'Finish or cancel your current measurement or calibration to save.'
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
            <button className="show-all-work-button" disabled={hasDraft} aria-pressed={showingAllWork} onClick={openAllMeasuredWork}>Show All Measured Work</button>
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

          <div hidden={sidebarTab !== 'materials'} className="materials-panel"><h2>Materials</h2><p>Materials calculations coming next.</p><p className="length-note">This will use your Measured Work to calculate material quantities.</p></div>
          <div hidden={sidebarTab !== 'summary'} className="summary-panel">
            <div className="summary-job-heading">{[job.site, job.plot ? 'Plot ' + job.plot : '', job.houseType, job.revision ? (/^rev\b/i.test(job.revision) ? job.revision : 'Rev ' + job.revision) : ''].filter(Boolean).join(' / ') || 'Job details not entered'}</div>
            <h2>Plot summary</h2>
            <div className="panel-subtitle">{measuredCategorySummaries.length} measured categories · all pages</div>
            <p className="length-note">Drawing visibility does not change these totals. Skim rows reuse the source areas and represent separate work.</p>
            {measuredCategorySummaries.map((category) => <div className="category-summary" key={category.id}>
              <strong><span className="category-swatch" style={{ background: category.color }} />{category.name || category.id}</strong>
              {category.mode === 'count' ? <div className="summary-values">{category.count} no.</div> : <div className="summary-values">
                <span>{category.totalAreaM2 === null ? 'Check calibration / heights' : `${category.totalAreaM2.toFixed(2)} m²`}</span>
                {category.mode !== 'derived' && <span>{category.totalMm === null ? 'LM awaiting calibration' : `${(category.totalMm / 1000).toFixed(2)} LM`}</span>}
              </div>}
              {category.mode === 'derived' && <details><summary>Automatic skim sources</summary>
                <p className="length-note">{category.id === 'skimmed-walls' ? 'From Tack Timber Wall, Tack Metal Wall and both Dabbed Wall categories.' : 'From Tack Ceiling.'} Source groups can opt out using Include this area in skim.</p>
                <ul className="group-members">{category.sourceGroups.map((group) => <li key={group.id}>{group.name || group.id} · {group.totalAreaM2 === null ? 'Check measurements' : `${group.totalAreaM2.toFixed(2)} m²`}</li>)}</ul>
              </details>}
              {category.wallsWithoutHeight > 0 && <p className="length-note">{category.wallsWithoutHeight} lengths/runs without height are excluded from m².</p>}
            </div>)}
            {!measuredCategorySummaries.length && <p className="length-note">No categories measured yet.</p>}
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
                  Lengths ({currentLengthMeasurements.length}) · {lengthCalibrationValid ? `${(renderedLengths.reduce((sum, item) => sum + (item.lengthMm ?? 0), 0) / 1000).toFixed(2)} m` : 'Calibration required'}
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
                    <summary>{measurement.name || measurement.id} · {measurement.lengthMm === null ? '—' : `${(measurement.lengthMm / 1000).toFixed(2)} m`}
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
                <button className="delete-page-button" aria-label={`Delete drawing page ${page.name}`} disabled={drawingPages.length <= 1 || hasDraft} title={drawingPages.length <= 1 ? 'Keep at least one drawing page' : 'Remove this page and its measurements'} onClick={() => deleteDrawingPage(index+1)}>×</button>
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


          <p className="status" role="status">{status}</p>
          </div>
        </aside>

        <section
          hidden={sidebarTab === 'summary'}
          ref={stageRef}
          tabIndex={-1}
          className={`drawing-stage${isPanning ? ' is-panning' : ''}${calibrationMode || lengthMode || runMode || areaMode || countMode || readyToolKind ? ' measurement-active' : ''}`}
          onPointerDown={(event) => { setSnapPreview(null); startPan(event) }}
          onPointerMove={(event) => { movePan(event); previewSnap(event) }}
          onPointerLeave={() => setSnapPreview(null)}
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
                className={`measurement-overlay${overviewDrawing ? ' overview-drawing' : ''}`}
                width={viewportSize.width}
                height={viewportSize.height}
                style={{
                  pointerEvents: 'none',
                }}
              >
                {renderedAreas.map((area) => (
                  <g key={area.id} opacity={measurementAppearance(area.groupId).opacity}>
                    {area.handles.length > 1 && (area.id === 'Draft area'
                      ? <polyline points={area.handles.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={area.color} strokeWidth={measurementAppearance(area.groupId).width} strokeDasharray="7 4" />
                      : <polygon points={area.handles.map((p) => `${p.x},${p.y}`).join(' ')} fill={`${area.color}22`} stroke={area.color} strokeWidth={measurementAppearance(area.groupId).width} />)}
                    {area.id !== 'Draft area' && area.handles.length > 0 && <text
                      x={area.handles[0].x + 12} y={area.handles[0].y - 12} className="run-label area-label" style={{ fill: area.color }}>
                      {area.id} · {area.areaM2 === null ? 'invalid' : `${area.areaM2.toFixed(2)} m²`}
                    </text>}
                    {area.handles.map((point, i) => <circle key={i} cx={point.x} cy={point.y} r={area.locked ? 5 : 8}
                      fill={area.color} stroke="white" strokeWidth="2"
                      style={{ pointerEvents: !area.locked && lengthCalibrationValid && !hasDraft ? 'all' : 'none', cursor: 'move' }}
                      onPointerDown={(event) => startAreaHandleDrag(event, area.id, i)}
                      onPointerMove={moveAreaHandle} onPointerUp={endAreaHandleDrag} onPointerCancel={endAreaHandleDrag} />)}
                  </g>
                ))}

                {calibrationLine && !overviewDrawing && (
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
                          strokeWidth={measurementAppearance(measurement.groupId).width}
                        />

                        <g
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
                              ? `${measurement.id} · ${(measurement.lengthMm / 1000).toFixed(2)} m`
                              : `${measurement.id} · invalid`}
                          </text>
                        </g>
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
                            {run.id}.{i + 1} · {lengthCalibrationValid ? `${(run.segments[i] / 1000).toFixed(2)} m` : 'invalid'}
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
                        onPointerDown={(event) => startRunHandleDrag(event, run.id, i)}
                        onPointerMove={moveRunHandle} onPointerUp={endRunHandleDrag} onPointerCancel={endRunHandleDrag} />
                    ))}
                  </g>
                ))}

                {renderedCounts.map((count) => <g key={count.id} opacity={measurementAppearance(count.groupId).opacity}>
                  <path d={`M ${count.x - 8} ${count.y - 8} L ${count.x + 8} ${count.y + 8} M ${count.x + 8} ${count.y - 8} L ${count.x - 8} ${count.y + 8}`}
                    stroke={count.color} strokeWidth={measurementAppearance(count.groupId).width} />
                  <text x={count.x + 12} y={count.y - 10} className="run-label" style={{ fill: count.color }}>{count.id}</text>
                  <circle cx={count.x} cy={count.y} r="12" fill="transparent" style={{ pointerEvents: !count.locked && !hasDraft ? 'all' : 'none', cursor: 'move' }}
                    onPointerDown={(event) => startCountHandleDrag(event, count.id)} onPointerMove={moveCountHandle} onPointerUp={endCountHandleDrag} onPointerCancel={endCountHandleDrag} />
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
        {sidebarTab === 'summary' && <section className="summary-gallery" aria-label="All drawings and page quantities">
          <header className="summary-gallery-heading"><h2>All Drawings — Page Breakdown</h2><p>Whole-plot totals are on the left. Each drawing below has its own measurements and quantities.</p></header>
          {!pdf && <p className="summary-empty">Import a drawing to see the page breakdown.</p>}
          {pdf && pageDrawingSummaries.map((page) => <article className="summary-page-card" key={page.number}>
            <header className="summary-page-heading"><div><h3>{page.name}</h3><p>Drawing {page.number} of {drawingPages.length} · {page.measurementCount} measured elements</p></div><button onClick={() => { goToDrawingPage(page.number); navigateWorkspace('measure') }}>Open drawing</button></header>
            <div className="summary-page-content">
              <SummaryDrawingPreview pdf={pdf} number={page.number} rotation={rotation} lengths={lengthMeasurements[page.number] ?? []} runs={runMeasurements[page.number] ?? []} areas={areaMeasurements[page.number] ?? []} counts={(countMeasurements[page.number] ?? []).map((item) => ({...item,previewColor:summaryColorFor(item.groupId,categories.find((category) => category.id === countCategoryId(item))?.color ?? '#dc2626')}))} colorFor={summaryColorFor} appearanceFor={measurementAppearance} preparePage={prepareSummaryPage} />
              <div className="summary-page-quantities"><h4>{page.name} quantities</h4>
                {page.needsCalibration && <p className="calibration-warning">Calibrate and lock this drawing to show complete quantities.</p>}
                {!page.rows.length && <p className="length-note">No measured work on this drawing yet.</p>}
                {page.rows.map((row) => <div className="summary-page-quantity" key={row.id}>
                  <h5><span className="work-legend-swatches">{row.colors.map((color) => <span className="work-legend-swatch" key={color} style={{background:color}} />)}</span>{row.name}</h5>
                  <div className="summary-page-values">{row.mode !== 'count' && <><strong>{row.totalAreaM2 === null ? 'Check calibration / heights' : row.totalAreaM2.toFixed(2) + ' m²'}</strong>{row.mode !== 'derived' && <span>{row.totalMm === null ? 'Check calibration' : (row.totalMm/1000).toFixed(2) + ' LM'}</span>}</>}{(row.mode === 'count' || row.count>0) && <strong>{row.count} no.</strong>}</div>
                  {row.wallsWithoutHeight>0 && <p className="length-note">{row.wallsWithoutHeight} lengths/runs without height excluded from m².</p>}
                  {row.sourceNote && <p className="skim-source-note">{row.sourceNote}</p>}
                </div>)}
              </div>
            </div>
          </article>)}
        </section>}
        {showingAllWork && <aside className="work-details-panel" aria-label="All Measured Work quantities" onKeyDown={(event) => {
          if (event.key === 'Escape') { event.stopPropagation(); setSelectedWorkId(null) }
        }}>
          <div className="work-details-header"><h2>All Measured Work — All Drawings</h2>
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
            <div className="workspace-tally"><span>Measured elements</span><strong>{allMeasurements.length}</strong><p>Across {pdf?.numPages ?? 0} drawing pages</p></div>
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
              return <div className="work-height-editor"><label>Wall height on this drawing (m)<input type="number" min="0.001" step="any" aria-label="Work wall height" aria-invalid={invalid} value={value} placeholder={heights.length > 1 ? 'Mixed heights' : 'Add wall height'} onChange={(event) => setWorkWallHeight(selectedWork.id, event.target.value, pageNumber)} /></label><p className="length-note">Applies to this work’s lengths/runs on this drawing only. You can also edit individual heights below.</p>{invalid && <p className="calibration-warning">Enter a height greater than zero, or clear it.</p>}</div>
            })()}
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
            <h3>Individual measurements</h3>
            <div className="work-member-list">
              {selectedWorkItems.map((item) => <details className="work-member-card" key={item.id}>
                <summary><strong>{item.name || item.id}</strong><span>{drawingPageName(item.page)} · {item.kind === 'count' ? '1 no.' : item.kind === 'area'
                  ? item.areaM2 === null ? 'Check calibration' : `${item.areaM2.toFixed(2)} m²`
                  : item.lengthMm === null ? 'Check calibration' : `${(item.lengthMm / 1000).toFixed(2)} m`}</span></summary>
                <p className="length-note">{item.id}{item.heightM !== undefined ? ` · height ${item.heightM} m` : ''}</p>
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
        {measurementMenu && contextItem && <div className="measurement-context-menu" data-measurement-menu role="menu" aria-label="Measurement actions" style={{left:measurementMenu.x,top:measurementMenu.y}} onContextMenu={(event) => event.preventDefault()}>
          <div className="context-menu-title">{contextItem.name || contextItem.id}<span>{contextItem.locked ? 'Locked' : 'Unlocked'}</span></div>
          {hasDraft && <p>Finish the current measurement to edit this one.</p>}
          <button role="menuitem" autoFocus disabled={hasDraft || (measurementMenu.kind !== 'point' && !lengthCalibrationValid)} onClick={() => measurementMenuAction('edit')}>Edit points</button>
          <button role="menuitem" disabled={hasDraft} onClick={() => measurementMenuAction('lock')}>{contextItem.locked ? 'Unlock' : 'Lock'}</button>
          <button role="menuitem" className="context-menu-delete" disabled={hasDraft} onClick={() => measurementMenuAction('delete')}>Delete</button>
          <button role="menuitem" onClick={() => setMeasurementMenu(null)}>Close</button>
        </div>}
      </main>
      {showCalibrationWarning && !measurementChooser && !heightPromptOpen && <div className="calibration-notice-position" onKeyDown={(event) => {
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
          <label>Wall height (metres)
            <input autoFocus type="number" min="0.001" step="any" inputMode="decimal" aria-label="Starting wall height" value={startingWallHeight}
              placeholder="e.g. 2.4" onChange={(event) => setStartingWallHeight(event.target.value)} />
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
