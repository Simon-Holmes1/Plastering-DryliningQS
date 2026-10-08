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
  pointA: Point
  pointB: Point
  locked: boolean
}

type Pan = {
  x: number
  y: number
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

  async function openPdf(file: File) {
    try {
      setStatus('Loading drawing…')

      const bytes = new Uint8Array(await file.arrayBuffer())
      const loadedPdf = await pdfjsLib.getDocument({ data: bytes }).promise

      setPdf(loadedPdf)
      setFileName(file.name)
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

      setStatus(
        `Loaded ${loadedPdf.numPages} page${loadedPdf.numPages === 1 ? '' : 's'}.`
      )
    } catch (error) {
      console.error(error)
      setStatus('Could not open that PDF. Try another file.')
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
    if (!pdf || pageNumber <= 1) return

    setPageNumber((current) => current - 1)
    setViewMode('fit-page')
    setPan({ x: 0, y: 0 })
  }

  function nextPage() {
    if (!pdf || pageNumber >= pdf.numPages) return

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

  function startLengthMeasurement() {
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
        { id, pointA, pointB, locked: true },
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
    if (!pdf) return

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

    let disposed = false

    async function renderPage() {
      const page = await pdf.getPage(pageNumber)

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
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">DRYLINING TAKE-OFF</div>
          <h1>{fileName || 'New take-off'}</h1>
        </div>

        <label className="upload-button">
          Upload drawing

          <input
            type="file"
            accept="application/pdf"
            onChange={(event) => {
              const file = event.target.files?.[0]

              if (file) {
                openPdf(file)
              }
            }}
          />
        </label>
      </header>

      <main className="workspace">
        <aside className="sidebar">
          <h2>Job</h2>

          <label>
            Site
            <input placeholder="e.g. Oak Meadow" />
          </label>

          <label>
            Plot
            <input placeholder="e.g. 23" />
          </label>

          <label>
            House type
            <input placeholder="e.g. Warwick" />
          </label>

          <label>
            Drawing revision
            <input placeholder="e.g. Rev B" />
          </label>

          <hr />

          <h2>Drawing</h2>

          <div className="tool-row">
            <button
              disabled={!pdf || pageNumber <= 1}
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
              disabled={!pdf || pageNumber >= (pdf?.numPages ?? 1)}
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

          <h2>Measurement</h2>

          <button
            className="future-tool"
            disabled={!pdf}
            onClick={calibrationMode ? cancelCalibration : startCalibration}
          >
            {calibrationMode ? 'Cancel Calibration' : 'Calibrate'}
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
                currentCalibration.needsRecalibration
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
                <button onClick={unlockCalibration}>
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
              >
                Clear Calibration
              </button>
            </div>
          )}

          <button
            className="future-tool"
            disabled={
              !currentCalibration ||
              !currentCalibration.locked ||
              currentCalibration.needsRecalibration
            }
            onClick={
              lengthMode
                ? cancelLengthMeasurement
                : startLengthMeasurement
            }
          >
            {lengthMode ? 'Cancel Length' : '+ Add Length'}
          </button>

          {currentLengthMeasurements.length > 0 && (
            <div
              className={`length-panel ${
                lengthCalibrationValid ? '' : 'invalid'
              }`}
            >
              <div className="length-panel-heading">
                <strong>
                  Lengths ({currentLengthMeasurements.length})
                </strong>

                <button
                  className="clear-all-lengths"
                  onClick={clearAllLengths}
                >
                  Clear all
                </button>
              </div>

              {!lengthCalibrationValid && (
                <div className="calibration-warning">
                  Recalibrate and lock this page before using these measurements.
                </div>
              )}

              <div className="length-list">
                {renderedLengths.map((measurement) => (
                  <div
                    className="length-list-item"
                    key={measurement.id}
                  >
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
                  </div>
                ))}
              </div>

              <div className="length-note">
                Fine-tune a measurement, then tick Lock. Locked end points do not
                intercept clicks, so another length can start from the same corner.
              </div>
            </div>
          )}

          <button className="future-tool" disabled>
            Area
          </button>

          <button className="future-tool" disabled>
            Count
          </button>

          <p className="status">{status}</p>
        </aside>

        <section
          ref={stageRef}
          className={`drawing-stage${isPanning ? ' is-panning' : ''}${calibrationMode || lengthMode ? ' measurement-active' : ''}`}
          onPointerDown={startPan}
          onPointerMove={movePan}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          onWheel={handleWheelZoom}
        >
          {!pdf && (
            <label className="drop-zone">
              <strong>Upload a construction drawing</strong>
              <span>PDF only for the first prototype</span>

              <input
                type="file"
                accept="application/pdf"
                onChange={(event) => {
                  const file = event.target.files?.[0]

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
                        pointerEvents: 'all',
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
                        pointerEvents: 'all',
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
                {renderedLengths.map((measurement) => (
                  <g key={measurement.id}>
                    {measurement.line && (
                      <>
                        <line
                          x1={measurement.line.x1}
                          y1={measurement.line.y1}
                          x2={measurement.line.x2}
                          y2={measurement.line.y2}
                          stroke="#2563eb"
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
                            stroke="#2563eb"
                            strokeWidth="1"
                          />
                          <text
                            x="0"
                            y="3"
                            textAnchor="middle"
                            fontSize="12"
                            fontWeight="700"
                            fill="#1d4ed8"
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
                        fill="#2563eb"
                        stroke="#ffffff"
                        strokeWidth="2"
                        style={{
                          pointerEvents: measurement.locked ? 'none' : 'all',
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
                        fill="#2563eb"
                        stroke="#ffffff"
                        strokeWidth="2"
                        style={{
                          pointerEvents: measurement.locked ? 'none' : 'all',
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
      </main>
    </div>
  )
}
