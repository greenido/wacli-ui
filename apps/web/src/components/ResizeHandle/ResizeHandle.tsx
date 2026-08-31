import React, { useState, useRef } from 'react';

interface ResizeHandleProps {
  side: 'left' | 'right';
  currentWidth: number;
  minWidth?: number;
  maxWidth?: number;
  onResize: (newWidth: number) => void;
  onReset?: () => void;
}

export const ResizeHandle: React.FC<ResizeHandleProps> = ({
  side,
  currentWidth,
  minWidth = 200,
  maxWidth = 600,
  onResize,
  onReset,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setIsDragging(true);
    startXRef.current = e.clientX;
    startWidthRef.current = currentWidth;
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    const delta = e.clientX - startXRef.current;
    const newWidth = side === 'left' ? startWidthRef.current + delta : startWidthRef.current - delta;
    const clamped = Math.min(Math.max(newWidth, minWidth), maxWidth);
    onResize(clamped);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDragging) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      setIsDragging(false);
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${side === 'left' ? 'chats' : 'system status'} sidebar`}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={onReset}
      className={`relative w-1.5 shrink-0 select-none cursor-col-resize z-20 transition-colors group flex items-center justify-center ${
        isDragging
          ? 'bg-mc-live shadow-[0_0_8px_rgba(37,211,102,0.4)]'
          : 'bg-mc-border hover:bg-mc-live/70 active:bg-mc-live'
      }`}
      title="Drag to resize panel (Double-click to reset)"
    >
      {/* Visual grip pill on hover */}
      <div
        className={`w-0.5 h-6 rounded-full transition-colors pointer-events-none ${
          isDragging ? 'bg-[#12151B]' : 'bg-transparent group-hover:bg-[#12151B]'
        }`}
      />
    </div>
  );
};
