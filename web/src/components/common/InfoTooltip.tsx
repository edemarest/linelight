"use client";

import { useState, useRef, useLayoutEffect } from "react";
import { createPortal } from "react-dom";

interface InfoTooltipProps {
  content: string;
  iconSize?: "sm" | "md";
}

export const InfoTooltip = ({ content, iconSize = "sm" }: InfoTooltipProps) => {
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [mounted, setMounted] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);

  const fontSize = iconSize === "sm" ? "text-xs" : "text-sm";

  useLayoutEffect(() => {
    setMounted(true);
  }, []);

  useLayoutEffect(() => {
    if (isVisible && triggerRef.current) {
      const updatePosition = () => {
        const triggerRect = triggerRef.current!.getBoundingClientRect();
        
        const tooltipWidth = 240;
        const tooltipHeight = 60;
        
        const top = triggerRect.top - tooltipHeight - 8;
        let left = triggerRect.left + triggerRect.width / 2 - tooltipWidth / 2;
        
        // Keep tooltip on screen
        if (left < 8) left = 8;
        if (left + tooltipWidth > window.innerWidth - 8) {
          left = window.innerWidth - tooltipWidth - 8;
        }
        
        setPosition({ top, left });
      };
      
      updatePosition();
      window.addEventListener('scroll', updatePosition, true);
      window.addEventListener('resize', updatePosition);
      
      return () => {
        window.removeEventListener('scroll', updatePosition, true);
        window.removeEventListener('resize', updatePosition);
      };
    }
  }, [isVisible]);

  const handleMouseEnter = () => setIsVisible(true);
  const handleMouseLeave = () => setIsVisible(false);

  const tooltip = isVisible && mounted ? createPortal(
    <div 
      className="info-tooltip-content"
      style={{ 
        top: `${position.top}px`, 
        left: `${position.left}px`,
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="info-tooltip-arrow" style={{
        left: triggerRef.current ? `${triggerRef.current.getBoundingClientRect().left + 9 - position.left}px` : '50%',
      }} />
      <p className="text-xs leading-snug">{content}</p>
    </div>,
    document.body
  ) : null;

  return (
    <>
      <span
        ref={triggerRef as any}
        role="button"
        tabIndex={0}
        className={`info-tooltip-trigger ${fontSize}`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onFocus={handleMouseEnter}
        onBlur={handleMouseLeave}
        aria-label="More information"
      >
        <span style={{ fontStyle: "normal" }}>ⓘ</span>
      </span>
      {tooltip}
    </>
  );
};
