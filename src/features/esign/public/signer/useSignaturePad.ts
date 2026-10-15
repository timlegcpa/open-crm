import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { SIGNATURE_INK } from '../../lib/signatureFonts';

const STROKE_WIDTH = 2.5;
/** Retina pads would send four times the pixels for nothing; the server bounds the pixel count. */
const MAX_PAD_DPR = 2;
/** Device pixels kept around the ink when cropping on export. */
const CROP_PADDING = 8;

/**
 * A hand-rolled signature pad. Two things are load-bearing:
 *   - the canvas is never filled, so the PNG keeps its alpha and lands on the PDF without a
 *     white box over the line;
 *   - the export crops to the ink, so a small scrawl in a corner is not stamped as a tiny
 *     mark floating in white space.
 * The backing store is sized only while the pad is empty: resizing wipes the bitmap, and a
 * signature must not vanish because a phone was rotated.
 */
export function useSignaturePad(visible: boolean) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hasInk, setHasInk] = useState(false);
  // A ref too, so the sizing effects can read it without re-running on the first stroke
  // (re-running would refit, and refitting erases the stroke that triggered it).
  const hasInkRef = useRef(false);
  const drawing = useRef(false);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const lastMid = useRef<{ x: number; y: number } | null>(null);

  const fit = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_PAD_DPR);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = STROKE_WIDTH;
    ctx.strokeStyle = SIGNATURE_INK;
    ctx.fillStyle = SIGNATURE_INK;
  }, []);

  // The draw panel stays mounted while hidden (a drawing survives a tab switch), so it
  // measures 0x0 at mount: size it when it becomes visible.
  useEffect(() => {
    if (visible && !hasInkRef.current) fit();
  }, [fit, visible]);

  useEffect(() => {
    const onResize = () => {
      if (!drawing.current && !hasInkRef.current) fit();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [fit]);

  const pointFrom = (e: PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drawing.current = true;
    const p = pointFrom(e);
    lastPoint.current = p;
    lastMid.current = p;
    // A tap with no movement still leaves a dot.
    ctx.beginPath();
    ctx.arc(p.x, p.y, STROKE_WIDTH / 2, 0, Math.PI * 2);
    ctx.fill();
    hasInkRef.current = true;
    setHasInk(true);
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext('2d');
    const prev = lastPoint.current;
    const prevMid = lastMid.current;
    if (!ctx || !prev || !prevMid) return;
    const p = pointFrom(e);
    // A curve through the midpoints: straight segments read as a polyline at signing speed.
    const mid = { x: (prev.x + p.x) / 2, y: (prev.y + p.y) / 2 };
    ctx.beginPath();
    ctx.moveTo(prevMid.x, prevMid.y);
    ctx.quadraticCurveTo(prev.x, prev.y, mid.x, mid.y);
    ctx.stroke();
    lastPoint.current = p;
    lastMid.current = mid;
  };

  const endStroke = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    drawing.current = false;
    lastPoint.current = null;
    lastMid.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const clear = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    hasInkRef.current = false;
    setHasInk(false);
  }, []);

  /** The ink, cropped, as bare base64 PNG (no data: prefix); null when empty. */
  const exportBase64 = useCallback((): string | null => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return null;
    const { width, height } = canvas;
    if (width === 0 || height === 0) return null;
    const { data } = ctx.getImageData(0, 0, width, height);
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (data[(y * width + x) * 4 + 3] === 0) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return null;
    const sx = Math.max(0, minX - CROP_PADDING);
    const sy = Math.max(0, minY - CROP_PADDING);
    const sw = Math.min(width, maxX + CROP_PADDING + 1) - sx;
    const sh = Math.min(height, maxY + CROP_PADDING + 1) - sy;
    const out = document.createElement('canvas');
    out.width = sw;
    out.height = sh;
    const outCtx = out.getContext('2d');
    if (!outCtx) return null;
    outCtx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    const url = out.toDataURL('image/png');
    const comma = url.indexOf(',');
    return comma >= 0 ? url.slice(comma + 1) : null;
  }, []);

  return { canvasRef, hasInk, clear, exportBase64, onPointerDown, onPointerMove, endStroke };
}
