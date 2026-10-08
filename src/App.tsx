import { useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

type PdfDoc = Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>
type ViewMode = 'fit-page' | 'manual'

type Pan = {
  x: number
  y: number
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stageRef = useRef<HTMLElement | null>(null)
  const renderTaskRef = useRef<any>(null)

  const panStartRef = useRef({
    active: false,
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

    setPan({
      x: start.panX + (event.clientX - start.clientX),
      y: start.panY + (event.clientY - start.clientY),
    })
  }

  function endPan(event: React.PointerEvent<HTMLElement>) {
    const start = panStartRef.current

    if (!start.active || start.pointerId !== event.pointerId) return

    start.active = false
    setIsPanning(false)

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
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

  const zoomPercent = Math.max(25, Math.min(500, Math.round(scale * 100)))

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
              max="500"
              step="5"
              value={zoomPercent}
              disabled={!pdf}
              onChange={(event) => handleZoomSlider(event.target.value)}
            />

            <div className="zoom-labels">
              <span>25%</span>
              <span>500%</span>
            </div>
          </div>

          <div className="view-status">
            {pdf
              ? `${viewMode === 'fit-page' ? 'Fit page' : 'Manual zoom'} · ${rotation}°`
              : 'No drawing loaded'}
          </div>

          <hr />

          <h2>Next tools</h2>

          <button className="future-tool" disabled>
            Calibrate
          </button>

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
          className={`drawing-stage${isPanning ? ' is-panning' : ''}`}
          onPointerDown={startPan}
          onPointerMove={movePan}
          onPointerUp={endPan}
          onPointerCancel={endPan}
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
              className="drawing-positioner"
              style={{
                width: viewportSize.width,
                height: viewportSize.height,
                transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))`,
              }}
            >
              <canvas ref={canvasRef} />
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
