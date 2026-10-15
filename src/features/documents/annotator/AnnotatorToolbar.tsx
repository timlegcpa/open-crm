import { Highlighter, List as ListIcon, MousePointer2, Pen, Stamp as StampIcon, Type } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ClickRegion } from '@/components/ui/click-region';
import { CountBadge } from '@/components/ui/count-badge';
import {
  HIGHLIGHT_BRUSHES,
  HIGHLIGHT_COLORS,
  INK_COLORS,
  REVIEW_STAMP_META,
  STAMP_META,
  type DocumentAnnotation,
  type HighlightMode,
  type ReviewStampKey,
  type StampKey,
} from '../lib/annotations';
import AnnotatorExport from './AnnotatorExport';
import type { AnnotatorDoc } from './types';

export type AnnotatorTool = 'select' | 'pen' | 'highlight' | 'text' | 'stamp';

const TOOLS: Array<{ key: AnnotatorTool; icon: typeof Pen; label: string }> = [
  { key: 'select', icon: MousePointer2, label: 'Select' },
  { key: 'pen', icon: Pen, label: 'Draw' },
  { key: 'highlight', icon: Highlighter, label: 'Highlight' },
  { key: 'text', icon: Type, label: 'Text' },
  { key: 'stamp', icon: StampIcon, label: 'Stamp' },
];

interface AnnotatorToolbarProps {
  tool: AnnotatorTool;
  onToolChange: (tool: AnnotatorTool) => void;
  inkColor: string;
  onInkColorChange: (color: string) => void;
  highlightColor: string;
  onHighlightColorChange: (color: string) => void;
  highlightMode: HighlightMode;
  onHighlightModeChange: (mode: HighlightMode) => void;
  highlightBrush: number;
  onHighlightBrushChange: (width: number) => void;
  stampKey: StampKey | ReviewStampKey;
  onStampKeyChange: (key: StampKey | ReviewStampKey) => void;
  doc: AnnotatorDoc;
  getBytes: () => Uint8Array | null;
  hasBytes: boolean;
  annotations: DocumentAnnotation[];
  panelOpen: boolean;
  onPanelToggle: () => void;
}

function ColorSwatches({
  colors,
  active,
  onChange,
}: {
  colors: readonly string[];
  active: string;
  onChange: (color: string) => void;
}) {
  return (
    <div className="ml-1 flex items-center gap-1.5 border-l border-border pl-2">
      {colors.map((c) => (
        <ClickRegion
          key={c}
          onClick={() => onChange(c)}
          className={`h-5 w-5 rounded-full border border-border transition-shadow ${
            c === active ? 'ring-2 ring-ring ring-offset-1' : 'hover:ring-1 hover:ring-ring'
          }`}
          // The one legitimate inline colour here: the swatch's fill IS the
          // annotation ink value, a runtime string, not a theme role.
          style={{ backgroundColor: c }}
          aria-label={`Color ${c}`}
          aria-pressed={c === active}
        />
      ))}
    </div>
  );
}

/**
 * Box/freehand switch for the Highlight tool. Deliberately `role="group"` +
 * `aria-pressed` rather than a Radix Tabs list: this toolbar already lives
 * inside the workstation's own tab structure, and a nested tablist misreports
 * the surface to assistive tech (2026-08-03 closeout precedent).
 */
function HighlightModeToggle({
  mode,
  onChange,
}: {
  mode: HighlightMode;
  onChange: (mode: HighlightMode) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Highlight shape"
      className="ml-1 flex items-center gap-0.5 rounded-sm border border-border p-0.5"
    >
      {(['box', 'freehand'] as const).map((m) => {
        const active = mode === m;
        return (
          <Button
            key={m}
            type="button"
            variant="ghost"
            onClick={() => onChange(m)}
            aria-pressed={active}
            className={`h-auto rounded-md px-1.5 py-0.5 text-[12px] font-medium ${
              active ? 'bg-foreground text-primary-foreground hover:bg-foreground' : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {m === 'box' ? 'Box' : 'Freehand'}
          </Button>
        );
      })}
    </div>
  );
}

/** Brush widths as proportionally-sized dots: the control shows what it does. */
function BrushSizes({
  active,
  color,
  onChange,
}: {
  active: number;
  color: string;
  onChange: (width: number) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Brush size"
      className="ml-1 flex items-center gap-1.5 border-l border-border pl-2"
    >
      {HIGHLIGHT_BRUSHES.map((w) => {
        const isActive = w === active;
        const dot = 6 + (w - HIGHLIGHT_BRUSHES[0]) * 0.5;
        return (
          <Button
            key={w}
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => onChange(w)}
            aria-pressed={isActive}
            aria-label={`Brush ${w}`}
            title={`Brush ${w}`}
            className={`h-6 w-6 ${isActive ? 'bg-muted' : 'hover:bg-muted'}`}
          >
            <span
              className="rounded-full border border-border"
              style={{ width: dot, height: dot, backgroundColor: color }}
            />
          </Button>
        );
      })}
    </div>
  );
}

export default function AnnotatorToolbar({
  tool,
  onToolChange,
  inkColor,
  onInkColorChange,
  highlightColor,
  onHighlightColorChange,
  highlightMode,
  onHighlightModeChange,
  highlightBrush,
  onHighlightBrushChange,
  stampKey,
  onStampKeyChange,
  doc,
  getBytes,
  hasBytes,
  annotations,
  panelOpen,
  onPanelToggle,
}: AnnotatorToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-border bg-card px-3 py-1.5">
      {TOOLS.map(({ key, icon: Icon, label }) => {
        const active = tool === key;
        return (
          <Button
            key={key}
            type="button"
            variant="ghost"
            size="sm"
            className={`h-7 gap-1 px-2 ${
              active
                ? 'bg-foreground text-primary-foreground hover:bg-foreground hover:text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => onToolChange(key)}
            title={label}
            aria-pressed={active}
          >
            <Icon className="h-3.5 w-3.5" />
            <span className="hidden text-[12px] font-medium md:inline">{label}</span>
          </Button>
        );
      })}

      {/* Text notes share the pen palette: the note's color is captured at creation. */}
      {(tool === 'pen' || tool === 'text') && (
        <ColorSwatches colors={INK_COLORS} active={inkColor} onChange={onInkColorChange} />
      )}
      {tool === 'highlight' && (
        <>
          <HighlightModeToggle mode={highlightMode} onChange={onHighlightModeChange} />
          <ColorSwatches colors={HIGHLIGHT_COLORS} active={highlightColor} onChange={onHighlightColorChange} />
          {highlightMode === 'freehand' && (
            <BrushSizes active={highlightBrush} color={highlightColor} onChange={onHighlightBrushChange} />
          )}
        </>
      )}
      {tool === 'stamp' && (
        <div className="ml-1 flex items-center gap-1 border-l border-border pl-2">
          {/* Review stamps first: they are the ones the owner reaches for most, and they
              auto-place rather than following the cursor like the glyphs do. */}
          {(Object.keys(REVIEW_STAMP_META) as ReviewStampKey[]).map((k) => {
            const meta = REVIEW_STAMP_META[k];
            const active = stampKey === k;
            return (
              <Button
                key={k}
                type="button"
                variant="outline"
                onClick={() => onStampKeyChange(k)}
                className={`h-6 rounded-md px-1.5 text-[10px] font-bold tracking-wide ${
                  active ? 'border-border bg-muted hover:bg-muted' : 'border-border bg-card hover:bg-muted'
                }`}
                style={{ color: meta.color }}
                title={`${meta.label}. Stamps bottom-right with today's date`}
                aria-pressed={active}
              >
                {meta.label}
              </Button>
            );
          })}
          <span className="mx-0.5 h-4 w-px bg-muted" aria-hidden="true" />
          {(Object.keys(STAMP_META) as StampKey[]).map((k) => {
            const meta = STAMP_META[k];
            const active = stampKey === k;
            return (
              <Button
                key={k}
                type="button"
                variant="outline"
                onClick={() => onStampKeyChange(k)}
                className={`h-6 gap-1 rounded-md px-1.5 ${
                  active ? 'border-border bg-muted hover:bg-muted' : 'border-border bg-card hover:bg-muted'
                }`}
                title={meta.label}
                aria-pressed={active}
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden="true">
                  <path
                    d={meta.path}
                    fill="none"
                    stroke={meta.color}
                    strokeWidth={3}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="text-[12px] text-muted-foreground">{meta.label}</span>
              </Button>
            );
          })}
        </div>
      )}

      <div className="ml-auto flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={`h-8 gap-1.5 px-2 ${panelOpen ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
          onClick={onPanelToggle}
          aria-pressed={panelOpen}
          title="Marks on this document"
        >
          <ListIcon className="h-3.5 w-3.5" />
          <span className="text-[12px] font-medium">Marks</span>
          <CountBadge
            value={annotations.length}
            tone="neutral"
            title={`${annotations.length} mark${annotations.length === 1 ? '' : 's'} on this document`}
          />
        </Button>
        <AnnotatorExport doc={doc} getBytes={getBytes} hasBytes={hasBytes} annotations={annotations} />
      </div>
    </div>
  );
}
