import { useEffect, useRef, useState } from 'react'
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

type MeasurementGroup = { id: string; name: string; categoryId?: string; includeSkim?: boolean }
type WorkCategory = { id: string; name: string; color: string; mode: 'measure' | 'count' | 'derived'; skimTarget?: 'walls' | 'ceilings' }
type CountMeasurement = { id: string; name?: string; groupId?: string; categoryId?: string; point: Point; locked: boolean }
type MeasurementKind = 'length' | 'run' | 'area' | 'point'

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
type TakeoffFile = {
  format: 'drylining-takeoff'
  version: 5
  savedAt: string
  drawing: { name: string; pdfBase64: string }
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
  if (![1, 2, 3, 4, 5].includes(value.version)) {
    throw new Error('This take-off uses a different file version. Open it with the version of the app that saved it.')
  }
  if (!object(value.drawing) || typeof value.drawing.name !== 'string' || !value.drawing.name.trim()
    || !isValidPdfBase64(value.drawing.pdfBase64)
    || typeof value.savedAt !== 'string' || !Number.isFinite(Date.parse(value.savedAt))) invalid()
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
  return { ...value, version: 5, groups, nextGroupNumber, areas, nextAreaNumber, categories, counts, nextCountNumber } as TakeoffFile
}

export default function App() {
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
  const [sidebarTab, setSidebarTab] = useState<'measure' | 'groups' | 'summary'>('measure')
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
  const wallIds = new Set([...Object.values(lengthMeasurements).flat(), ...Object.values(runMeasurements).flat()].map((item) => item.id))
  const hasInvalidHeight = Object.entries(heightDrafts).some(([id, text]) => wallIds.has(id)
    && text !== '' && (!Number.isFinite(Number(text)) || Number(text) <= 0))

  // View changes do not mark measurements as changed, but the view is saved too.
  const dataSignature = JSON.stringify({ job, calibrations, lengths: lengthMeasurements,
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
    if (!runMode && !areaMode && !countMode && !lengthMode) return
    window.addEventListener('keydown', finishWithEnter)
    return () => window.removeEventListener('keydown', finishWithEnter)
  }, [runMode, runPoints, areaMode, areaPoints, countMode, lengthMode, measurementChooser, calibrations, pageNumber])

  function finishWithEnter(event: KeyboardEvent) {
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
        format: 'drylining-takeoff', version: 5, savedAt,
        drawing: { name: fileName, pdfBase64: encodePdf(pdfBytesRef.current) },
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
    try {
      let raw: unknown
      try { raw = JSON.parse(await file.text()) }
      catch { throw new Error('This is not a readable take-off file. Your current work has been kept.') }
      const saved = readTakeoff(raw)
      const bytes = decodePdf(saved.drawing.pdfBase64)
      // PDF.js may transfer its input buffer to the worker. Keep our own copy for saving again.
      loadedPdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise
      const pages = [...Object.keys(saved.calibrations), ...Object.keys(saved.lengths), ...Object.keys(saved.runs), ...Object.keys(saved.areas), ...Object.keys(saved.counts)]
      if (saved.view.page > loadedPdf.numPages || pages.some((key) => Number(key) > loadedPdf!.numPages)) {
        throw new Error('The saved measurements refer to a missing PDF page. Your current work has been kept.')
      }
      resetDrafts()
      pdfBytesRef.current = bytes
      setPdf(loadedPdf)
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
      setSavedSignature(JSON.stringify({ job: saved.job, calibrations: saved.calibrations,
        lengths: saved.lengths, runs: saved.runs, nextLengthNumber: saved.nextLengthNumber,
        nextRunNumber: saved.nextRunNumber, groups: saved.groups, nextGroupNumber: saved.nextGroupNumber,
        areas: saved.areas, nextAreaNumber: saved.nextAreaNumber,
        counts: saved.counts, nextCountNumber: saved.nextCountNumber, categories: saved.categories }))
      setLastSavedAt(saved.savedAt)
      setStatus(`Opened ${file.name}. Your drawing, job details and measurements are restored.`)
      loadedPdf = null // Ownership has passed to the viewer.
    } catch (error) {
      console.error(error)
      setStatus(error instanceof Error ? error.message : 'Could not open that take-off. Your current work has been kept.')
    } finally {
      if (loadedPdf) void loadedPdf.destroy()
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
      const loadedPdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise

      pdfBytesRef.current = bytes
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
      } else if (runMode) {
        addRunPoint(event.clientX, event.clientY)
      } else if (areaMode) {
        addAreaPoint(event.clientX, event.clientY)
      } else if (countMode) {
        addCountPoint(event.clientX, event.clientY)
      } else if (lengthMode) {
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

    return { x: pdfX, y: pdfY }
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
    return categories.find((category) => category.id === group?.categoryId)?.color ?? fallback
  }

  function countCategoryId(item: CountMeasurement) {
    return item.categoryId ?? groups.find((group) => group.id === item.groupId)?.categoryId ?? 'svp-boxing'
  }

  function requestMeasurement(kind: MeasurementKind) {
    if (!pdf || hasDraft || queuedStart || (kind !== 'point' && !hasValidCalibration())) return
    const mode = kind === 'point' ? 'count' : 'measure'
    const category = categories.find((item) => item.id === activeGroup?.categoryId && item.mode === mode)
      ?? categories.find((item) => item.id === chooserCategoryId && item.mode === mode)
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
      setStartingWallHeight('')
      setHeightPromptOpen(true)
      return
    }
    commitMeasurementStart()
  }

  function confirmRunHeight(skip = false) {
    if (!heightPromptOpen || measurementChooser !== 'run') return
    const value = startingWallHeight.trim()
    if (!skip && value !== '' && (!Number.isFinite(Number(value)) || Number(value) <= 0)) return
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
    if (kind === 'length') startLengthMeasurement()
    else if (kind === 'run') startRun(runHeightM)
    else if (kind === 'area') startArea()
    else if (kind === 'point') startCounting()
  }

  function selectViewCategory(categoryId: string) {
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
    if (!countMode || !pdf || activeCategory?.mode !== 'count') return
    const point = clientToPdfPoint(clientX, clientY)
    if (!point) return
    if ((countMeasurements[pageNumber] ?? []).some((item) => countCategoryId(item) === activeCategory.id && Math.hypot(item.point.x - point.x, item.point.y - point.y) < 0.000001)) return
    const id = `C${String(nextCountNumberRef.current++).padStart(3, '0')}`
    setCountMeasurements((current) => ({ ...current,
      [pageNumber]: [...(current[pageNumber] ?? []), { id, point, locked: true, groupId: activeGroupId, categoryId: activeCategory.id }],
    }))
  }

  function finishCounting() {
    setCountMode(false)
    setStatus('Point marks are kept and locked. They can now be saved with the take-off.')
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
    if (!areaMode || !hasValidCalibration()) return
    const point = clientToPdfPoint(clientX, clientY)
    if (!point) return
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
    setStatus(`${id} finished and locked. Untick Lock to adjust its corners.`)
  }

  function cancelArea() {
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

  function setWallHeight(id: string, text: string) {
    setHeightDrafts((current) => ({ ...current, [id]: text }))
    if (text === '') updateMeasurementDetails(id, { heightM: undefined })
    else if (Number.isFinite(Number(text)) && Number(text) > 0) updateMeasurementDetails(id, { heightM: Number(text) })
  }

  function wallHeightField(id: string, heightM: number | undefined, lengthMm: number | null) {
    const text = heightDrafts[id] ?? (heightM === undefined ? '' : String(heightM))
    const invalid = text !== '' && (!Number.isFinite(Number(text)) || Number(text) <= 0)
    return (
      <div className="wall-height-field">
        <label>
          Wall height (m, optional)
          <input type="number" min="0.001" step="any" inputMode="decimal" value={text}
            placeholder="e.g. 2.4" aria-label={`Wall height for ${id}`} aria-invalid={invalid}
            onChange={(event) => setWallHeight(id, event.target.value)} />
        </label>
        {invalid ? <p className="calibration-warning">Enter a height greater than zero, or clear the field.</p>
          : heightM !== undefined ? <>
            <div className="wall-area-result">{lengthMm === null ? 'Calibration required' : `${((lengthMm / 1000) * heightM).toFixed(3)} m²`}</div>
            <p className="length-note">{lengthMm === null ? '' : `${(lengthMm / 1000).toFixed(3)} m × ${heightM} m · `}One face, before deductions.</p>
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

  function updateMeasurementDetails(id: string, details: { name?: string; groupId?: string; heightM?: number }) {
    if (details.groupId && !groups.some((group) => group.id === details.groupId)) return
    if (details.groupId) {
      const categoryId = groups.find((group) => group.id === details.groupId)?.categoryId
      if (id.startsWith('C') ? categories.find((category) => category.id === categoryId)?.mode !== 'count' : categories.find((category) => category.id === categoryId)?.mode === 'count') return
    }
    if (details.heightM !== undefined && (!Number.isFinite(details.heightM) || details.heightM <= 0 || id.startsWith('A'))) return
    // Names and membership can change while geometry stays locked.
    setLengthMeasurements((current) => ({
      ...current,
      [pageNumber]: (current[pageNumber] ?? []).map((item) => item.id === id ? { ...item, ...details } : item),
    }))
    setRunMeasurements((current) => ({
      ...current,
      [pageNumber]: (current[pageNumber] ?? []).map((item) => item.id === id ? { ...item, ...details } : item),
    }))
    if (!('heightM' in details)) setAreaMeasurements((current) => ({
      ...current,
      [pageNumber]: (current[pageNumber] ?? []).map((item) => item.id === id ? { ...item, ...details } : item),
    }))
    if (!('heightM' in details)) setCountMeasurements((current) => ({ ...current,
      [pageNumber]: (current[pageNumber] ?? []).map((item) => item.id === id ? { ...item, ...details,
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
    if (!runMode || !hasValidCalibration()) return
    const point = clientToPdfPoint(clientX, clientY)
    if (!point) return
    setRunPoints((current) => {
      const last = current[current.length - 1]
      // Ignore repeated clicks without preventing a return to an earlier corner.
      if (last && Math.hypot(point.x - last.x, point.y - last.y) < 0.000001) {
        return current
      }
      return [...current, point]
    })
  }

  function finishRun() {
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
    setStatus(`${id} finished and locked. Use Measure Continuous Length to measure more walls, or untick Lock to drag its corners.`)
  }

  function cancelRun() {
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
    setLengthMode(false)
    setLengthPoints([])
    setStatus('Length measurement cancelled.')
  }

  function addLengthPoint(clientX: number, clientY: number) {
    if (!lengthMode) return

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
        { id, pointA, pointB, locked: true, ...(activeGroupId ? { groupId: activeGroupId } : {}) },
      ],
    }))

    setLengthPoints([])
    setLengthMode(false)
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
    if (!pdf || viewMode !== 'fit-page') return

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
  }, [pdf, pageNumber, rotation, viewMode, stageResizeTick])

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
    if (!pdf || !canvasRef.current) return

    const document = pdf
    let disposed = false

    async function renderPage() {
      const page = await document.getPage(pageNumber)

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
  }, [pdf, pageNumber, scale, rotation])

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
  const groupSummaries = groups.map((group) => {
    const members = allMeasurements.filter((item) => item.groupId === group.id)
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
  })
  const categorySummaries = categories.map((category) => {
    const sourceGroups = groupSummaries.filter((group) => category.mode === 'derived'
      ? group.includeSkim !== false && categories.find((item) => item.id === group.categoryId)?.skimTarget === (category.id === 'skimmed-walls' ? 'walls' : 'ceilings')
      : group.categoryId === category.id)
    const totalMm = category.mode === 'derived' ? 0 : sourceGroups.some((group) => group.totalMm === null) ? null
      : sourceGroups.reduce((sum, group) => sum + (group.totalMm ?? 0), 0)
    const totalAreaM2 = sourceGroups.some((group) => group.totalAreaM2 === null) ? null
      : sourceGroups.reduce((sum, group) => sum + (group.totalAreaM2 ?? 0), 0)
    return { ...category, sourceGroups, totalMm, totalAreaM2,
      count: category.mode === 'count' ? Object.values(countMeasurements).flat().filter((item) => countCategoryId(item) === category.id).length : 0,
      wallsWithoutHeight: sourceGroups.reduce((sum, group) => sum + group.wallsWithoutHeight, 0) }
  })
  const selectedWork = groupSummaries.find((group) => group.id === selectedWorkId)
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
  const selectedWorkItems = allMeasurements.filter((item) => item.groupId === selectedWorkId).map(withQuantities)
  const ungroupedItems = allMeasurements.filter((item) => !item.groupId).map(withQuantities)
  const ungroupedGeometry = ungroupedItems.filter((item) => item.kind !== 'count')
  const workOverviewRows = [
    ...groupSummaries.map((group) => ({ id: group.id, name: group.name || group.id,
      mode: categories.find((category) => category.id === group.categoryId)?.mode ?? 'measure',
      totalMm: group.totalMm, totalAreaM2: group.totalAreaM2, count: group.count })),
    ...(ungroupedItems.length ? [{ id: '__ungrouped__', name: 'Ungrouped Measurements', mode: 'mixed',
      totalMm: ungroupedGeometry.some((item) => item.lengthMm === null) ? null : ungroupedGeometry.reduce((sum, item) => sum + (item.lengthMm ?? 0), 0),
      totalAreaM2: ungroupedGeometry.some((item) => item.kind === 'area' || item.heightM !== undefined ? item.areaM2 === null : false) ? null
        : ungroupedGeometry.reduce((sum, item) => sum + (item.areaM2 ?? 0), 0),
      count: ungroupedItems.filter((item) => item.kind === 'count').length }] : []),
  ]
  const calibrationAttention = !!pdf && !currentCalibration && !calibrationMode && !pendingCalibration
  const renderedCounts = currentCounts.filter((item) => isMeasurementVisible(item.groupId, countCategoryId(item))).map((item) => {
    const [x, y] = viewportRef.current?.convertToViewportPoint(item.point.x, item.point.y) ?? [0, 0]
    return { ...item, x, y, color: categories.find((category) => category.id === countCategoryId(item))?.color ?? '#dc2626' }
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

  const zoomPercent = Math.max(25, Math.min(1500, Math.round(scale * 100)))

  return (
    <div className="app-shell" aria-busy={isFileBusy}>
      <header className="topbar" inert={isFileBusy || !!measurementChooser || heightPromptOpen}>
        <div>
          <div className="eyebrow">DRYLINING TAKE-OFF</div>
          <h1>{fileName || 'New take-off'}</h1>
        </div>

        <div className="file-actions">
          <button className="save-takeoff-button" disabled={!pdf || isFileBusy || hasDraft || hasInvalidHeight}
            title={hasDraft ? 'Finish or cancel your current measurement or calibration first' : 'Download the PDF, job details and measurements together'}
            onClick={saveTakeoff}>Save Measure</button>
          <label className={`upload-button open-takeoff-button ${isFileBusy ? 'file-disabled' : ''}`}>
            Open Measure
            <input type="file" accept=".json,.takeoff.json,application/json" disabled={isFileBusy}
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void openTakeoff(file)
              }} />
          </label>
        <label className={`upload-button ${isFileBusy ? 'file-disabled' : ''}`}>
          Import New Drawing

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
        <section className="banner-job" aria-label="Job details">

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

      <main className={`workspace ${selectedWork || showingAllWork ? 'has-work-details' : ''}`} inert={isFileBusy || !!measurementChooser || heightPromptOpen}>
        <aside className="sidebar">
          <div className="sidebar-fixed">
          <nav className="sidebar-tabs" aria-label="Take-off sections">
            {(['measure', 'groups', 'summary'] as const).map((tab) => <button key={tab}
              aria-pressed={sidebarTab === tab} onClick={() => { setSidebarTab(tab); if (tab !== 'groups') setSelectedWorkId(null) }}>
              {tab === 'measure' ? 'New Measure' : tab === 'groups' ? 'Measured Work' : 'Summary'}
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
          <div hidden={sidebarTab !== 'measure'}>
          <h2>Drawing</h2>

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


          <div className="measured-work-list" hidden={sidebarTab !== 'groups'}>
            <h2>Measured Work</h2>
            <p className="length-note">Choose a work item to see its quantities and measurements on the right.</p>
            <button className="show-all-work-button" disabled={hasDraft} aria-pressed={showingAllWork} onClick={openAllMeasuredWork}>Show All Measured Work</button>
            <div className="work-buttons">
              {groupSummaries.map((group) => <button className="work-item-button" key={group.id}
                aria-pressed={selectedWorkId === group.id} disabled={hasDraft} onClick={() => openMeasuredWork(group.id)}>
                <strong>{group.name || group.id}</strong>
                <span>{categories.find((category) => category.id === group.categoryId)?.name || 'Uncategorised'} · {group.members.length} measurements</span>
              </button>)}
            </div>
            {!groups.length && <p className="length-note">No measured work yet. Start a measurement in New Measure to create your first work item.</p>}
            <details className="create-work-item"><summary>Create a work item (optional)</summary>
              <form onSubmit={(event) => { event.preventDefault(); createGroup() }}>
                <label>Work item name<input value={newGroupName} maxLength={100} placeholder="e.g. First floor timber walls"
                  disabled={!pdf || hasDraft} onChange={(event) => setNewGroupName(event.target.value)} /></label>
                <button className="wide-control" type="submit" disabled={!pdf || hasDraft || !newGroupName.trim()}>Create Work Item</button>
              </form>
            </details>
          </div>

          <div hidden={sidebarTab !== 'summary'} className="summary-panel">
            <h2>Work summary · all pages</h2>
            <p className="length-note">Drawing visibility does not change these totals. Skim rows reuse the source areas and represent separate work.</p>
            {categorySummaries.map((category) => <div className="category-summary" key={category.id}>
              <strong><span className="category-swatch" style={{ background: category.color }} />{category.name || category.id}</strong>
              {category.mode === 'count' ? <div className="summary-values">{category.count} no.</div> : <div className="summary-values">
                {category.mode !== 'derived' && <span>{category.totalMm === null ? 'LM awaiting calibration' : `${(category.totalMm / 1000).toFixed(3)} LM`}</span>}
                <span>{category.totalAreaM2 === null ? 'Check calibration / heights' : `${category.totalAreaM2.toFixed(3)} m²`}</span>
              </div>}
              {category.mode === 'derived' && <details><summary>Automatic skim sources</summary>
                <p className="length-note">{category.id === 'skimmed-walls' ? 'From Tack Timber Wall, Tack Metal Wall and both Dabbed Wall categories.' : 'From Tack Ceiling.'} Source groups can opt out using Include this area in skim.</p>
                <ul className="group-members">{category.sourceGroups.map((group) => <li key={group.id}>{group.name || group.id} · {group.totalAreaM2 === null ? 'Check measurements' : `${group.totalAreaM2.toFixed(3)} m²`}</li>)}</ul>
              </details>}
              {category.wallsWithoutHeight > 0 && <p className="length-note">{category.wallsWithoutHeight} lengths/runs without height are excluded from m².</p>}
            </div>)}
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

          <div hidden={sidebarTab !== 'measure'}>
          {(lengthMode || runMode || areaMode || countMode) && <div className="measuring-banner" role="status">
            <strong>{activeCategory?.name || 'Uncategorised'}</strong>
            <div>{activeGroup?.name || 'Ungrouped'} · {lengthMode ? 'Click the second point to finish' : 'Press Enter to finish'}</div>
          </div>}

          <button
            className="future-tool"
            disabled={
              runMode || areaMode || countMode || calibrationMode || !!pendingCalibration || !currentCalibration ||
              !currentCalibration.locked ||
              currentCalibration.needsRecalibration
            }
            onClick={
              lengthMode
                ? cancelLengthMeasurement
                : () => requestMeasurement('length')
            }
          >
            {lengthMode ? 'Cancel Length' : 'Measure Single Length'}
          </button>

          {!runMode ? (
            <button className="future-tool run-start" disabled={!lengthCalibrationValid || hasDraft} onClick={() => requestMeasurement('run')}>
              Measure Continuous Length
            </button>
          ) : (
            <div className="run-panel" aria-label="Current run">
              <strong>Run in progress</strong>
              <div className="length-primary" aria-live="polite">
                {(draftTotalMm / 1000).toFixed(3)} m
              </div>
              <div>{draftSegments.length} segment{draftSegments.length === 1 ? '' : 's'}</div>
              {runHeightM !== undefined && <div className="wall-area-result">{(draftTotalMm / 1000 * runHeightM).toFixed(3)} m² · height {runHeightM} m</div>}
              <p className="length-note">
                {runPoints.length === 0 ? 'Click your start point on the drawing.' : 'Click the next wall corner, then keep going. Drag to pan; use the wheel to zoom.'}
              </p>
              <button className="run-finish" disabled={runPoints.length < 2 || !lengthCalibrationValid} onClick={finishRun}>
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

          {currentRuns.length > 0 && (
            <details className={`run-panel measurement-section ${lengthCalibrationValid ? '' : 'invalid'}`}>
              <summary>Wall runs ({currentRuns.length}) · {lengthCalibrationValid ? `${(currentRuns.reduce((sum, run) => sum + runSegments(run.points).reduce((a, b) => a + b, 0), 0) / 1000).toFixed(3)} m` : 'Calibration required'}</summary>
              {!lengthCalibrationValid && <p className="calibration-warning">Recalibrate and lock this page before using these totals.</p>}
              <div className="length-list run-list">
                {currentRuns.map((run) => {
                  const segments = runSegments(run.points)
                  const totalMm = segments.reduce((sum, mm) => sum + mm, 0)
                  return (
                    <details className="run-list-item measurement-card" key={run.id}>
                      <summary>{run.name || run.id} · {lengthCalibrationValid ? `${(totalMm / 1000).toFixed(3)} m` : '—'}
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
                      <div className="length-primary">{lengthCalibrationValid ? `${(totalMm / 1000).toFixed(3)} m` : 'Calibration required'}</div>
                      {wallHeightField(run.id, run.heightM, lengthCalibrationValid ? totalMm : null)}
                      <details>
                        <summary>{segments.length} segments — show lengths</summary>
                        <ol className="run-segments">
                          {segments.map((mm, i) => <li key={i}>{lengthCalibrationValid ? `${(mm / 1000).toFixed(3)} m` : 'Calibration required'}</li>)}
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
                  Lengths ({currentLengthMeasurements.length}) · {lengthCalibrationValid ? `${(renderedLengths.reduce((sum, item) => sum + (item.lengthMm ?? 0), 0) / 1000).toFixed(3)} m` : 'Calibration required'}
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
                    <summary>{measurement.name || measurement.id} · {measurement.lengthMm === null ? '—' : `${(measurement.lengthMm / 1000).toFixed(3)} m`}
                      <span>{categories.find((category) => category.id === groups.find((group) => group.id === measurement.groupId)?.categoryId)?.name || 'Uncategorised'}</span>
                    </summary>
                    <div>
                      <strong>{measurement.id}</strong>

                      {measurement.lengthMm !== null ? (
                        <>
                          <div className="length-primary">
                            {(measurement.lengthMm / 1000).toFixed(3)} m
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

          {!areaMode ? <button className="future-tool area-start" disabled={!lengthCalibrationValid || hasDraft} onClick={() => requestMeasurement('area')}>Measure Area</button> : (
            <div className="area-panel" aria-label="Current area">
              <strong>Area in progress · {areaPoints.length} corners</strong>
              <div className="area-primary" aria-live="polite">{draftAreaM2 === null ? '— m²' : `${draftAreaM2.toFixed(3)} m² so far`}</div>
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
          {currentAreas.length > 0 && <details className={`area-panel measurement-section ${lengthCalibrationValid ? '' : 'invalid'}`}>
            <summary>Areas ({currentAreas.length}) · {lengthCalibrationValid ? `${(currentAreas.reduce((sum, area) => sum + polygonArea(area.points), 0) * currentCalibration.mmPerPdfUnit ** 2 / 1000000).toFixed(3)} m²` : 'Calibration required'}</summary>
            {!lengthCalibrationValid && <p className="calibration-warning">Calibrate and lock this page to show areas.</p>}
            <div className="length-list run-list">
              {currentAreas.map((area) => (
                <details className="area-list-item measurement-card" key={area.id}>
                  <summary>{area.name || area.id} · {lengthCalibrationValid ? `${(polygonArea(area.points) * currentCalibration.mmPerPdfUnit ** 2 / 1000000).toFixed(3)} m²` : '—'}
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
                  <div className="area-primary">{lengthCalibrationValid ? `${(polygonArea(area.points) * currentCalibration.mmPerPdfUnit ** 2 / 1000000).toFixed(3)} m²` : 'Calibration required'}</div>
                  <div>{area.points.length} corners</div>
                  {!area.locked && <p className="length-note">Drag a corner to adjust the outline, then tick Lock.</p>}
                </details>
              ))}
            </div>
          </details>}

          {!countMode ? <button className="future-tool count-start" disabled={!lengthCalibrationValid || hasDraft} onClick={() => requestMeasurement('point')}>Add Point Marker</button> : <div className="count-panel">
            <strong>{activeCategory?.name || 'Point marks'}</strong>
            <p>Click once at each location. Each cross counts as one. Press Enter or Done Marking to finish.</p>
            <button className="wide-control" onClick={finishCounting}>Done Marking</button>
          </div>}
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
          ref={stageRef}
          className={`drawing-stage${isPanning ? ' is-panning' : ''}${calibrationMode || lengthMode || runMode || areaMode || countMode ? ' measurement-active' : ''}`}
          onPointerDown={startPan}
          onPointerMove={movePan}
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
                className="measurement-overlay"
                width={viewportSize.width}
                height={viewportSize.height}
                style={{
                  pointerEvents: 'none',
                }}
              >
                {renderedAreas.map((area) => (
                  <g key={area.id}>
                    {area.handles.length > 1 && (area.id === 'Draft area'
                      ? <polyline points={area.handles.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={area.color} strokeWidth="3" strokeDasharray="7 4" />
                      : <polygon points={area.handles.map((p) => `${p.x},${p.y}`).join(' ')} fill={`${area.color}22`} stroke={area.color} strokeWidth="3" />)}
                    {area.id !== 'Draft area' && area.handles.length > 0 && <text
                      x={area.handles[0].x + 12} y={area.handles[0].y - 12} className="run-label area-label" style={{ fill: area.color }}>
                      {area.id} · {area.areaM2 === null ? 'invalid' : `${area.areaM2.toFixed(3)} m²`}
                    </text>}
                    {area.handles.map((point, i) => <circle key={i} cx={point.x} cy={point.y} r={area.locked ? 5 : 8}
                      fill={area.color} stroke="white" strokeWidth="2"
                      style={{ pointerEvents: !area.locked && lengthCalibrationValid && !hasDraft ? 'all' : 'none', cursor: 'move' }}
                      onPointerDown={(event) => startAreaHandleDrag(event, area.id, i)}
                      onPointerMove={moveAreaHandle} onPointerUp={endAreaHandleDrag} onPointerCancel={endAreaHandleDrag} />)}
                  </g>
                ))}

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
                {renderedLengths.filter((measurement) => measurement.visible).map((measurement) => (
                  <g key={measurement.id}>
                    {measurement.line && (
                      <>
                        <line
                          x1={measurement.line.x1}
                          y1={measurement.line.y1}
                          x2={measurement.line.x2}
                          y2={measurement.line.y2}
                          stroke={measurement.color}
                          strokeWidth="3"
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
                              ? `${measurement.id} · ${(measurement.lengthMm / 1000).toFixed(3)} m`
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
                  <g key={run.id}>
                    {run.handles.slice(1).map((end, i) => {
                      const start = run.handles[i]
                      return (
                        <g key={i}>
                          <line x1={start.x} y1={start.y} x2={end.x} y2={end.y}
                            stroke={run.color} strokeWidth="3" strokeDasharray={run.id === 'Draft' ? '7 4' : undefined} />
                          <text x={(start.x + end.x) / 2} y={(start.y + end.y) / 2 - 9}
                            className="run-label" textAnchor="middle" style={{ fill: run.color }}>
                            {run.id}.{i + 1} · {lengthCalibrationValid ? `${(run.segments[i] / 1000).toFixed(3)} m` : 'invalid'}
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

                {renderedCounts.map((count) => <g key={count.id}>
                  <path d={`M ${count.x - 8} ${count.y - 8} L ${count.x + 8} ${count.y + 8} M ${count.x + 8} ${count.y - 8} L ${count.x - 8} ${count.y + 8}`}
                    stroke={count.color} strokeWidth="3" />
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
              </svg>
            </div>
          )}
        </section>
        {showingAllWork && <aside className="work-details-panel" aria-label="All Measured Work quantities" onKeyDown={(event) => {
          if (event.key === 'Escape') { event.stopPropagation(); setSelectedWorkId(null) }
        }}>
          <div className="work-details-header"><h2>All Measured Work</h2>
            <button aria-label="Close measured work overview" onClick={() => setSelectedWorkId(null)}>×</button>
          </div>
          <div className="work-details-body work-overview">
            {workOverviewRows.map((work) => <div className="work-overview-row" key={work.id}>
              <h3>{work.name}</h3>
              <div className="work-overview-quantities">
                {work.mode !== 'count' && <>
                  <span>{work.totalMm === null ? 'Check calibration' : `${(work.totalMm / 1000).toFixed(3)} LM`}</span>
                  <span>{work.totalAreaM2 === null ? 'Check calibration / height' : `${work.totalAreaM2.toFixed(3)} m²`}</span>
                </>}
                {(work.mode === 'count' || work.count > 0) && <span>{work.count} no.</span>}
              </div>
            </div>)}
            {!workOverviewRows.length && <p className="length-note">No measurements yet.</p>}
          </div>
        </aside>}
        {selectedWork && <aside className="work-details-panel" aria-label="Measured Work details" onKeyDown={(event) => {
          if (event.key === 'Escape') { event.stopPropagation(); setSelectedWorkId(null) }
        }}>
          <div className="work-details-header">
            <div><div className="work-details-eyebrow">MEASURED WORK · {selectedWork.id}</div><h2>{selectedWork.name || selectedWork.id}</h2></div>
            <button aria-label="Close measured work details" onClick={() => setSelectedWorkId(null)}>×</button>
          </div>
          <div className="work-details-body">
            <p className="work-category-name"><span className="category-swatch" style={{ background: categories.find((category) => category.id === selectedWork.categoryId)?.color ?? '#64748b' }} />{categories.find((category) => category.id === selectedWork.categoryId)?.name || 'Uncategorised'}</p>
            <div className="work-quantity-summary" aria-live="polite">
              {categories.find((category) => category.id === selectedWork.categoryId)?.mode === 'count'
                ? <strong>{selectedWork.count} no.</strong> : <>
                  <strong>{selectedWork.totalMm === null ? 'Check calibration' : `${(selectedWork.totalMm / 1000).toFixed(3)} LM`}</strong>
                  <strong>{selectedWork.totalAreaM2 === null ? 'Check calibration / heights' : `${selectedWork.totalAreaM2.toFixed(3)} m²`}</strong>
                </>}
            </div>
            <p className="length-note">{selectedWork.members.length} measurements · totals across all pages</p>
            {selectedWork.invalidPages.length > 0 && <p className="calibration-warning">Calibrate and lock pages {selectedWork.invalidPages.join(', ')} to show complete totals.</p>}
            {selectedWork.wallsWithoutHeight > 0 && <p className="length-note">{selectedWork.wallsWithoutHeight} lengths/runs have no height and are excluded from m².</p>}
            <div className="work-visibility-actions">
              <button disabled={hasDraft} aria-pressed={viewGroupId === selectedWork.id} onClick={() => showOnlyMeasuredWork(selectedWork.id)}>Show Only This Measure on Drawing</button>
              <button disabled={hasDraft} onClick={showAllMeasurements}>Show All Measurements</button>
            </div>
            <h3>Individual measurements</h3>
            <div className="work-member-list">
              {selectedWorkItems.map((item) => <details className="work-member-card" key={item.id}>
                <summary><strong>{item.name || item.id}</strong><span>Page {item.page} · {item.kind === 'count' ? '1 no.' : item.kind === 'area'
                  ? item.areaM2 === null ? 'Check calibration' : `${item.areaM2.toFixed(3)} m²`
                  : item.lengthMm === null ? 'Check calibration' : `${(item.lengthMm / 1000).toFixed(3)} m`}</span></summary>
                <p className="length-note">{item.id}{item.heightM !== undefined ? ` · height ${item.heightM} m` : ''}</p>
                {item.kind === 'wall' && item.heightM !== undefined && <strong>{item.areaM2 === null ? 'Check calibration / height' : `${item.areaM2.toFixed(3)} m²`}</strong>}
                <button className="wide-control" disabled={hasDraft} onClick={() => { setPageNumber(item.page); setViewMode('fit-page'); setPan({ x: 0, y: 0 }); setStageResizeTick((tick) => tick + 1) }}>Go to Page {item.page}</button>
                {item.page === pageNumber ? <>
                  {measurementDetails(item.id, item.name, item.groupId)}
                  {item.kind === 'wall' && wallHeightField(item.id, item.heightM, item.lengthMm)}
                </> : <p className="length-note">Go to its page to edit this measurement.</p>}
              </details>)}
              {!selectedWorkItems.length && <p className="length-note">This work item has no measurements yet.</p>}
            </div>
            <details className="work-item-settings"><summary>Work item settings</summary>
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
          <details><summary>Group options (optional)</summary>
            <label>Add to group<select value={chooserGroupId} onChange={(event) => setChooserGroupId(event.target.value)}>
              {groups.filter((group) => group.categoryId === chooserCategoryId).map((group) => <option key={group.id} value={group.id}>{group.name || group.id}</option>)}
              <option value="__new__">Create a new group</option>
            </select></label>
            {chooserGroupId === '__new__' && <label>Group name (optional)<input value={chooserGroupName} maxLength={100} placeholder={categories.find((category) => category.id === chooserCategoryId)?.name}
              onChange={(event) => setChooserGroupName(event.target.value)} /></label>}
          </details>
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
