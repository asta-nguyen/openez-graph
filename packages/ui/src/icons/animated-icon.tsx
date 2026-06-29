import {
  forwardRef,
  useEffect,
  useRef,
  type ComponentType,
  type Ref,
} from "react";
import type { AnimatedIconHandle, AnimatedIconProps } from "./types";

type RawIconType = ComponentType<AnimatedIconProps & { ref?: Ref<AnimatedIconHandle> }>;

/**
 * HOC that wraps an itshover animated icon and automatically triggers its
 * animation when the closest button/link/label ancestor is hovered.
 *
 * The wrapper span uses `display: contents` so it's transparent to CSS
 * layout — absolute positioning, flex, grid all work as if the icon were
 * a direct child of its parent.
 */
export function withAutoAnimate(RawIcon: RawIconType) {
  const Wrapped = forwardRef<AnimatedIconHandle, AnimatedIconProps>((props, _externalRef) => {
    const iconRef = useRef<AnimatedIconHandle>(null);
    const spanRef = useRef<HTMLSpanElement>(null);

    useEffect(() => {
      const span = spanRef.current;
      if (!span) return;
      const parent = span.closest(
        "button, a, [role='button'], label, .group, [data-slot='sidebar-menu-button']",
      );
      if (!parent) return;

      const handleEnter = () => iconRef.current?.startAnimation();
      const handleLeave = () => iconRef.current?.stopAnimation();
      parent.addEventListener("mouseenter", handleEnter);
      parent.addEventListener("mouseleave", handleLeave);
      return () => {
        parent.removeEventListener("mouseenter", handleEnter);
        parent.removeEventListener("mouseleave", handleLeave);
      };
    }, []);

    return (
      <span ref={spanRef} style={{ display: "contents" }}>
        <RawIcon {...props} ref={iconRef} />
      </span>
    );
  });
  Wrapped.displayName = `withAutoAnimate(${RawIcon.displayName || RawIcon.name || "Icon"})`;
  return Wrapped;
}
