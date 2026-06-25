'use client'
import { useRef, useState } from 'react'
import { UploadCloud, FileText, X, AlertCircle } from 'lucide-react'

const ACCEPT = '.pdf,.csv,.xlsx,application/pdf,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

function DropZone({ label, hint, file, onFile, onClear, isProcessing, required }) {
  const inputRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)

  const handleDrop = e => {
    e.preventDefault()
    setDragOver(false)
    const dropped = e.dataTransfer.files?.[0]
    if (dropped) onFile(dropped)
  }

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <span className="font-mono text-label uppercase tracking-widest text-text-label">
          {label}{required && <span className="text-accent"> *</span>}
        </span>
        {!required && <span className="font-body text-data-sm text-text-muted">optional</span>}
      </div>

      {file ? (
        <div className="card px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <FileText size={16} className="text-accent flex-shrink-0" />
            <span className="font-mono text-data-sm text-text-secondary truncate">{file.name}</span>
          </div>
          <button onClick={onClear} aria-label="Remove file" className="text-text-muted hover:text-data-negative transition-colors">
            <X size={15} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          className={[
            'w-full card px-4 py-7 flex flex-col items-center gap-2 transition-colors duration-200',
            dragOver ? 'border-accent bg-accent-subtle' : 'hover:border-accent-border',
          ].join(' ')}
        >
          {isProcessing ? (
            <span className="inline-block w-5 h-5 border border-accent border-t-transparent rounded-full animate-spin" />
          ) : (
            <UploadCloud size={20} className="text-text-muted" />
          )}
          <span className="font-body text-data-sm text-text-secondary">
            {isProcessing ? 'Reading file…' : 'Drop a file or click to browse'}
          </span>
          <span className="font-body text-data-sm text-text-muted">{hint}</span>
        </button>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' }}
      />
    </div>
  )
}

export function FileUpload({
  primaryFile, secondaryFile, isProcessingFile, fileError,
  isExtracting, extractError,
  onPrimaryFile, onSecondaryFile, onClearPrimary, onClearSecondary,
  onExtract, onClearExtractError,
}) {
  return (
    <div className="w-full max-w-intake mx-auto">
      <p className="font-mono text-label uppercase tracking-widest text-accent mb-3">Upload</p>
      <h2 className="font-display font-semibold text-xl text-text-primary mb-2">Your capital account & fund terms</h2>
      <p className="font-body text-sm text-text-secondary leading-relaxed mb-8 max-w-[58ch]">
        Upload a capital account statement, and optionally the LPA or side-letter terms. PDF, Excel, and CSV are
        supported. The model pre-populates what it can find; you confirm everything before any projection runs.
      </p>

      <div className="space-y-5">
        <DropZone
          label="Capital account statement"
          hint="PDF, XLSX, or CSV — max 3MB"
          file={primaryFile}
          onFile={f => { onClearExtractError(); onPrimaryFile(f) }}
          onClear={onClearPrimary}
          isProcessing={isProcessingFile && !primaryFile}
          required
        />
        <DropZone
          label="Fund terms (LPA / side letter)"
          hint="Adds hurdle, carry, and catch-up terms"
          file={secondaryFile}
          onFile={onSecondaryFile}
          onClear={onClearSecondary}
          isProcessing={false}
        />
      </div>

      {(fileError || extractError) && (
        <div className="mt-5 flex items-start gap-2 px-4 py-3 card border-border">
          <AlertCircle size={14} className="text-data-negative flex-shrink-0 mt-0.5" />
          <p className="font-body text-data-sm text-text-secondary">{fileError || extractError}</p>
        </div>
      )}

      <button
        onClick={onExtract}
        disabled={!primaryFile || isExtracting}
        className="mt-8 w-full py-3 rounded-card font-mono text-sm tracking-wide bg-accent text-surface-950 font-medium
                   disabled:opacity-40 disabled:cursor-not-allowed hover:bg-accent-dim transition-colors duration-200
                   flex items-center justify-center gap-2"
      >
        {isExtracting ? (
          <>
            <span className="inline-block w-4 h-4 border border-surface-950 border-t-transparent rounded-full animate-spin" />
            Extracting fields…
          </>
        ) : (
          'Extract & Review'
        )}
      </button>
    </div>
  )
}
