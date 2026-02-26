import {
  forwardRef,
  cloneElement,
  isValidElement,
  type ReactNode,
  type HTMLAttributes,
  type ReactElement,
} from "react";

interface SlotProps extends HTMLAttributes<HTMLElement> {
  children?: ReactNode;
}

const Slot = forwardRef<HTMLElement, SlotProps>(
  ({ children, ...props }, ref) => {
    if (isValidElement(children)) {
      const childProps = (children as ReactElement<Record<string, unknown>>)
        .props;
      return cloneElement(children as ReactElement<Record<string, unknown>>, {
        ...props,
        ...childProps,
        ref,
      });
    }
    return null;
  },
);
Slot.displayName = "Slot";

export { Slot };
