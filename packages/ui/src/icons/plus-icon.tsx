import { forwardRef, useImperativeHandle, useCallback } from "react";
import type { AnimatedIconHandle, AnimatedIconProps } from "./types";
import { motion, useAnimate } from "motion/react";

const PlusIcon = forwardRef<AnimatedIconHandle, AnimatedIconProps>(
  ({ size = 24, color = "currentColor", strokeWidth = 2, className = "" }, ref) => {
    const [scope, animate] = useAnimate();

    const start = useCallback(async () => {
      await animate(
        ".plus-h, .plus-v",
        { scale: [1, 1.2, 1] },
        { duration: 0.5, ease: "easeInOut" },
      );
    }, [animate]);

    const stop = useCallback(async () => {
      await animate(
        ".plus-h, .plus-v",
        { scale: 1 },
        { duration: 0.2, ease: "easeOut" },
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
        <motion.path className="plus-h" d="M5 12h14" style={{ transformOrigin: "12px 12px" }} />
        <motion.path className="plus-v" d="M12 5v14" style={{ transformOrigin: "12px 12px" }} />
      </motion.svg>
    );
  },
);

PlusIcon.displayName = "PlusIcon";
export default PlusIcon;
