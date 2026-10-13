import { useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

type PdfDoc = Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>
type FitMode = 'manual' | 'page' | 'width'

type Point = {
  x: number
  y: number
}

type Calibration = {
  pointA: Point
  pointB: Point
  distanceMm: number
  mmPerPdfUnit: number
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stageRef = useRef<HTMLElement | null>(null)
  const viewportRef = useRef<any>(null)

  const [pdf, setPdf] = useState<PdfDoc | null>(null)
  const [fileName, setFileName] = useState('')
  const [pageNumber, setPageNumber] = useState(1)

  const [scale, setScale] = useState(1.25)
  const [rotation, setRotation] = useState(0)
  const [fitMode, setFitMode] = useState<FitMode>('manual')

  const [status, setStatus] = useState('Upload a PDF drawing to begin.')

  const [calibrationMode, setCalibrationMode] = useState(false)
  const [calibrationPoints, setCalibrationPoints] = useState<Point[]>([])
  const [pendingCalibration, setPendingCalibration] =
    useState<{ pointA: Point; pointB: Point } | null>(null)
  const [calibrationDistance, setCalibrationDistance] = useState('')
  const [calibrations, setCalibrations] = useState<Record<number, Calibration>>({})
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })

  async function openPdf(file: File) {
    try {
      setStatus('Loading drawing…')

      const bytes = new Uint8Array(await file.arrayBuffer())
      const loadedPdf = await pdfjsLib.getDocument({ data: bytes }).promise

      setPdf(loadedPdf)
      setFileName(file.name)
      setPageNumber(1)
      setRotation(0)
      setFitMode('page')
      setCalibrationMode(false)
      setCalibrationPoints([])
      setPendingCalibration(null)
      setCalibrationDistance('')
      setCalibrations({})

      setStatus(
        `Loaded ${loadedPdf.numPages} page${loadedPdf.numPages === 1 ? '' : 's'}.`
      )
    } catch (error) {
      console.error(error)
      setStatus('Could not open that PDF. Try another file.')
    }
  }

  async function calculateFitScale(
    mode: 'page' | 'width',
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

    const horizontalPadding = 56
    const verticalPadding = 56

    const availableWidth = Math.max(
      100,
      stage.clientWidth - horizontalPadding
    )

    const availableHeight = Math.max(
      100,
      stage.clientHeight - verticalPadding
    )

    const widthScale = availableWidth / baseViewport.width
    const heightScale = availableHeight / baseViewport.height

    if (mode === 'width') {
      return widthScale
    }

    return Math.min(widthScale, heightScale)
  }

  async function applyFit(mode: 'page' | 'width') {
    if (!pdf) return

    const fittedScale = await calculateFitScale(
      mode,
      pdf,
      pageNumber,
      rotation
    )

    setFitMode(mode)
    setScale(fittedScale)
  }

  function zoomOut() {
    setFitMode('manual')
    setScale((current) =>
      Math.max(0.1, +(current - 0.25).toFixed(2))
    )
  }

  function zoomIn() {
    setFitMode('manual')
    setScale((current) =>
      Math.min(6, +(current + 0.25).toFixed(2))
    )
  }

  function rotateLeft() {
    setRotation((current) => (current + 270) % 360)
  }

  function rotateRight() {
    setRotation((current) => (current + 90) % 360)
  }


  function startCalibration() {
    if (!pdf) return

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

  function handleCalibrationClick(event: React.MouseEvent<SVGSVGElement>) {
    if (!calibrationMode || !viewportRef.current) return

    const rect = event.currentTarget.getBoundingClientRect()
    const viewportX = event.clientX - rect.left
    const viewportY = event.clientY - rect.top

    const [pdfX, pdfY] =
      viewportRef.current.convertToPdfPoint(viewportX, viewportY)

    const newPoint: Point = { x: pdfX, y: pdfY }

    if (calibrationPoints.length === 0) {
      setCalibrationPoints([newPoint])
      setStatus('Calibration: now click the second end of the known dimension.')
      return
    }

    const pointA = calibrationPoints[0]
    const pointB = newPoint

    setCalibrationPoints([pointA, pointB])
    setPendingCalibration({ pointA, pointB })
    setCalibrationDistance('')
    setCalibrationMode(false)
    setStatus('Enter the known distance in millimetres to complete calibration.')
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

    const mmPerPdfUnit = distanceMm / pdfDistance

    setCalibrations((current) => ({
      ...current,
      [pageNumber]: {
        pointA,
        pointB,
        distanceMm,
        mmPerPdfUnit,
      },
    }))

    setPendingCalibration(null)
    setCalibrationPoints([])
    setCalibrationDistance('')
    setStatus(`Page ${pageNumber} calibrated to ${distanceMm.toLocaleString()} mm ✓`)
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
    setStatus(`Calibration removed from page ${pageNumber}.`)
  }

  useEffect(() => {
    if (!pdf || !canvasRef.current) return

    let cancelled = false

    async function renderPage() {
      const page = await pdf!.getPage(pageNumber)
      if (cancelled) return

      let renderScale = scale

      if (fitMode === 'page' || fitMode === 'width') {
        renderScale = await calculateFitScale(
          fitMode,
          pdf!,
          pageNumber,
          rotation
        )

        if (cancelled) return

        setScale(renderScale)
      }

      const viewport = page.getViewport({
        scale: renderScale,
        rotation,
      })

      viewportRef.current = viewport
      setViewportSize({
        width: viewport.width,
        height: viewport.height,
      })

      const canvas = canvasRef.current!
      const context = canvas.getContext('2d')!

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

      await page.render({
  canvas,
  canvasContext: context,
  viewport,
  transform,
}).promise
    }

    renderPage()

    return () => {
      cancelled = true
    }
  }, [pdf, pageNumber, scale, rotation, fitMode])

  useEffect(() => {
    if (!pdf || fitMode === 'manual') return

    function handleResize() {
      if (fitMode === 'page' || fitMode === 'width') {
  applyFit(fitMode)
}
    }

    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [pdf, fitMode, pageNumber, rotation])

  const currentCalibration = calibrations[pageNumber]

  let calibrationLine:
    | { x1: number; y1: number; x2: number; y2: number }
    | null = null

  const lineSource =
    currentCalibration ??
    (pendingCalibration
      ? {
          pointA: pendingCalibration.pointA,
          pointB: pendingCalibration.pointB,
        }
      : null)

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

  let temporaryPoint: { x: number; y: number } | null = null

  if (calibrationPoints.length === 1 && viewportRef.current) {
    const [x, y] = viewportRef.current.convertToViewportPoint(
      calibrationPoints[0].x,
      calibrationPoints[0].y
    )

    temporaryPoint = { x, y }
  }

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
              onClick={() =>
                setPageNumber((current) =>
                  Math.max(1, current - 1)
                )
              }
            >
              ←
            </button>

            <span>
              Page {pageNumber}
              {pdf ? ` / ${pdf.numPages}` : ''}
            </span>

            <button
              disabled={!pdf || pageNumber >= (pdf?.numPages ?? 1)}
              onClick={() =>
                setPageNumber((current) =>
                  Math.min(
                    pdf?.numPages ?? 1,
                    current + 1
                  )
                )
              }
            >
              →
            </button>
          </div>

          <div className="tool-row">
            <button
              disabled={!pdf}
              onClick={zoomOut}
              title="Zoom out"
            >
              −
            </button>

            <span>{Math.round(scale * 100)}%</span>

            <button
              disabled={!pdf}
              onClick={zoomIn}
              title="Zoom in"
            >
              +
            </button>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '8px',
              marginTop: '10px',
            }}
          >
            <button
              disabled={!pdf}
              onClick={() => applyFit('page')}
            >
              Fit Page
            </button>

            <button
              disabled={!pdf}
              onClick={() => applyFit('width')}
            >
              Fit Width
            </button>

            <button
              disabled={!pdf}
              onClick={rotateLeft}
              title="Rotate left"
            >
              ↶ Rotate
            </button>

            <button
              disabled={!pdf}
              onClick={rotateRight}
              title="Rotate right"
            >
              Rotate ↷
            </button>
          </div>

          <hr />

          <h2>Measurement</h2>

          <button
            className="future-tool"
            disabled={!pdf}
            onClick={calibrationMode ? cancelCalibration : startCalibration}
            style={{
              background: calibrationMode ? '#fff2d8' : undefined,
              borderColor: calibrationMode ? '#f0a62b' : undefined,
            }}
          >
            {calibrationMode ? 'Cancel Calibration' : 'Calibrate'}
          </button>

          {pendingCalibration && (
            <div
              style={{
                marginTop: '10px',
                padding: '10px',
                borderRadius: '8px',
                border: '1px solid #cad2df',
                background: '#ffffff',
              }}
            >
              <label
                style={{
                  display: 'block',
                  fontSize: '12px',
                  fontWeight: 700,
                }}
              >
                Known distance (mm)

                <input
                  autoFocus
                  type="number"
                  min="0"
                  step="1"
                  value={calibrationDistance}
                  onChange={(event) =>
                    setCalibrationDistance(event.target.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      saveCalibration()
                    }
                  }}
                  placeholder="e.g. 3600"
                  style={{
                    width: '100%',
                    marginTop: '6px',
                    padding: '9px',
                    border: '1px solid #cad2df',
                    borderRadius: '8px',
                  }}
                />
              </label>

              <button
                onClick={saveCalibration}
                style={{
                  width: '100%',
                  marginTop: '8px',
                }}
              >
                Save Calibration
              </button>
            </div>
          )}

          {currentCalibration && (
            <div
              style={{
                marginTop: '8px',
                padding: '10px',
                borderRadius: '8px',
                background: '#eaf7ee',
                border: '1px solid #b7dec2',
                fontSize: '12px',
                lineHeight: 1.5,
              }}
            >
              <strong>✓ Page calibrated</strong>

              <div>
                Known distance:{' '}
                {currentCalibration.distanceMm.toLocaleString()} mm
              </div>

              <button
                onClick={clearCalibration}
                style={{
                  marginTop: '8px',
                  width: '100%',
                }}
              >
                Clear Calibration
              </button>
            </div>
          )}

          <button className="future-tool" disabled>
            Length
          </button>

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
          className="drawing-stage"
        >
          {!pdf && (
            <label className="drop-zone">
              <strong>
                Upload a construction drawing
              </strong>

              <span>
                PDF only for the first prototype
              </span>

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
            <div className="canvas-wrap">
              <div
                style={{
                  position: 'relative',
                  width: viewportSize.width,
                  height: viewportSize.height,
                }}
              >
                <canvas
                  ref={canvasRef}
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                  }}
                />

                <svg
                  width={viewportSize.width}
                  height={viewportSize.height}
                  onClick={handleCalibrationClick}
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    cursor: calibrationMode ? 'crosshair' : 'default',
                    pointerEvents: calibrationMode ? 'auto' : 'none',
                  }}
                >
                  {calibrationLine && (
                    <>
                      <line
                        x1={calibrationLine.x1}
                        y1={calibrationLine.y1}
                        x2={calibrationLine.x2}
                        y2={calibrationLine.y2}
                        stroke="#e11d48"
                        strokeWidth="3"
                      />

                      <circle
                        cx={calibrationLine.x1}
                        cy={calibrationLine.y1}
                        r="6"
                        fill="#e11d48"
                      />

                      <circle
                        cx={calibrationLine.x2}
                        cy={calibrationLine.y2}
                        r="6"
                        fill="#e11d48"
                      />
                    </>
                  )}

                  {temporaryPoint && (
                    <circle
                      cx={temporaryPoint.x}
                      cy={temporaryPoint.y}
                      r="7"
                      fill="#f59e0b"
                    />
                  )}
                </svg>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}