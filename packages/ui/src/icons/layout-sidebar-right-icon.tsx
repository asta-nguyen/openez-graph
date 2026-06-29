import { forwardRef, useImperativeHandle, useCallback } from "react";
import type { AnimatedIconHandle, AnimatedIconProps } from "./types";
import { motion, useAnimate } from "motion/react";

const LayoutSidebarRightIcon = forwardRef<
  AnimatedIconHandle,
  AnimatedIconProps
>(
  (
    { size = 24, color = "currentColor", strokeWidth = 2, className = "" },
    ref,
  ) => {
    const [scope, animate] = useAnimate();

    const start = useCallback(async () => {
      // Slide the sidebar divider
      animate(
        ".sidebar",
        {
          x: [0, 4, 0],
        },
        {
          duration: 0.6,
          ease: "easeInOut",
          repeat: Infinity,
        },
      );

      // Pulse the container
      animate(
        ".container",
        {
          scale: [1, 1.08, 1],
        },
        {
          duration: 0.6,
          ease: "easeInOut",
          repeat: Infinity,
        },
      );
    }, [animate]);

    const stop = useCallback(async () => {
      animate(
        ".sidebar, .container",
        {
          x: 0,
          scale: 1,
        },
        {
          duration: 0.25,
          ease: "easeInOut",
        },
      );
    }, [animate]);

    useImperativeHandle(ref, () => ({
      startAnimation: start,
      stopAnimation: stop,
    }));

    return (
      <motion.svg
        ref={scope}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`cursor-pointer ${className}`}
        onHoverStart={start}
        onHoverEnd={stop}
      >
        <path stroke="none" d="M0 0h24v24H0z" fill="none" />

        {/* Container */}
        <motion.path
          className="container"
          d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"
        />

        {/* Sidebar divider */}
        <motion.path className="sidebar" d="M15 4l0 16" />
      </motion.svg>
    );
  },
);

LayoutSidebarRightIcon.displayName = "LayoutSidebarRightIcon";
export default LayoutSidebarRightIcon;
