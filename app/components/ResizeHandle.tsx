"use client";

import { useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

export type ResizeHandleProps = {
  className?: string;
  orientation: "vertical" | "horizontal";
  label: string;
  controls?: string;
  value: number;
  min: number;
  max: number;
  valueText?: string;
  disabled?: boolean;
  keyboardStep?: number;
  largeKeyboardStep?: number;
  onDragStart?: () => void;
  onDrag: (deltaPixels: number) => void;
  onDragEnd?: (deltaPixels: number) => void;
  onNudge: (deltaPixels: number) => void;
  onBoundary?: (boundary: "min" | "max") => void;
  onReset?: () => void;
};

type ActiveDrag = {
  pointerId: number;
  axis: "x" | "y";
  startCoordinate: number;
  lastDelta: number;
};

function coordinate(
  event: ReactPointerEvent<HTMLDivElement>,
  axis: ActiveDrag["axis"],
) {
  return axis === "x" ? event.clientX : event.clientY;
}

export function ResizeHandle({
  className = "",
  orientation,
  label,
  controls,
  value,
  min,
  max,
  valueText,
  disabled = false,
  keyboardStep = 16,
  largeKeyboardStep = 48,
  onDragStart,
  onDrag,
  onDragEnd,
  onNudge,
  onBoundary,
  onReset,
}: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<ActiveDrag | null>(null);
  const dragEndRef = useRef(onDragEnd);

  useEffect(() => {
    dragEndRef.current = onDragEnd;
  }, [onDragEnd]);

  useEffect(() => () => {
    const drag = dragRef.current;
    if (drag) dragEndRef.current?.(drag.lastDelta);
  }, []);

  const finishDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    includeFinalCoordinate: boolean,
  ) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    if (includeFinalCoordinate) {
      drag.lastDelta = coordinate(event, drag.axis) - drag.startCoordinate;
      onDrag(drag.lastDelta);
    }

    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onDragEnd?.(drag.lastDelta);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0 || dragRef.current) return;

    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);

    const axis = orientation === "vertical" ? "x" : "y";
    dragRef.current = {
      pointerId: event.pointerId,
      axis,
      startCoordinate: coordinate(event, axis),
      lastDelta: 0,
    };
    setDragging(true);
    onDragStart?.();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    drag.lastDelta = coordinate(event, drag.axis) - drag.startCoordinate;
    onDrag(drag.lastDelta);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;

    const step = event.shiftKey ? largeKeyboardStep : keyboardStep;
    let delta: number | null = null;

    if (orientation === "vertical") {
      if (event.key === "ArrowLeft") delta = -step;
      if (event.key === "ArrowRight") delta = step;
    } else {
      if (event.key === "ArrowUp") delta = -step;
      if (event.key === "ArrowDown") delta = step;
    }

    if (delta !== null) {
      event.preventDefault();
      onNudge(delta);
      return;
    }

    if (event.key === "Home" && onBoundary) {
      event.preventDefault();
      onBoundary("min");
    } else if (event.key === "End" && onBoundary) {
      event.preventDefault();
      onBoundary("max");
    }
  };

  const classes = [
    "resize-handle",
    `is-${orientation}`,
    dragging ? "is-dragging" : "",
    disabled ? "is-disabled" : "",
    className,
  ].filter(Boolean).join(" ");

  return (
    <div
      className={classes}
      role="separator"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-controls={controls}
      aria-orientation={orientation}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value * 100) / 100}
      aria-valuetext={valueText}
      aria-disabled={disabled || undefined}
      title={onReset ? `${label}. Double-click to reset.` : label}
      data-orientation={orientation}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishDrag(event, true)}
      onPointerCancel={(event) => finishDrag(event, false)}
      onLostPointerCapture={(event) => finishDrag(event, false)}
      onKeyDown={handleKeyDown}
      onDoubleClick={disabled ? undefined : onReset}
    />
  );
}
