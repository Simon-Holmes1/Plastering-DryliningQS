import { useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

type PdfDoc = Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>
type FitMode = 'manual' | 'page' | 'width'

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stageRef = useRef<HTMLElement | null>(null)

  const [pdf, setPdf] = useState<PdfDoc | null>(null)
  const [fileName, setFileName] = useState('')
  const [pageNumber, setPageNumber] = useState(1)

  const [scale, setScale] = useState(1.25)
  const [rotation, setRotation] = useState(0)
  const [fitMode, setFitMode] = useState<FitMode>('manual')

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
      setFitMode('page')

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
              <canvas ref={canvasRef} />
            </div>
          )}
        </section>
      </main>
    </div>
  )
}