import {
  type KeyEvent,
  type OptimizedBuffer,
  type RGBA,
  SelectRenderable,
  type SelectOption,
} from "@opentui/core";

export interface OpenTuiPaneWidthSpec {
  readonly minWidth: number;
  readonly width: `${number}%`;
}

export const OPEN_TUI_MAIN_PANE_LAYOUT = {
  details: { width: "30%", minWidth: 0 },
  nodes: { width: "22%", minWidth: 18 },
  sessions: { width: "28%", minWidth: 18 },
  workflows: { width: "20%", minWidth: 16 },
} as const satisfies Readonly<Record<string, OpenTuiPaneWidthSpec>>;

export interface OpenTuiFocusableTarget {
  focus(): void;
}

interface BlurredSelectIndicatorLayout {
  readonly fontHeight: number;
  readonly linesPerItem: number;
  readonly maxVisibleItems: number;
  readonly scrollOffset: number;
  readonly selectedIndex: number;
  readonly selectedOption: SelectOption;
  readonly showDescription: boolean;
}

interface FocusAwareSelectPrivateState {
  readonly _backgroundColor: RGBA;
  readonly _descriptionColor: RGBA;
  readonly _font: string | undefined;
  readonly _options: readonly SelectOption[];
  readonly _selectedIndex: number;
  readonly _showDescription: boolean;
  readonly _textColor: RGBA;
  readonly fontHeight: number;
  readonly linesPerItem: number;
  readonly maxVisibleItems: number;
  readonly scrollOffset: number;
}

interface BlurredSelectRedrawTarget {
  readonly descriptionY: number | undefined;
  readonly name: string;
  readonly nameY: number;
}

export function resolveBlurredSelectRedrawTarget(
  input: BlurredSelectIndicatorLayout,
): BlurredSelectRedrawTarget | undefined {
  const visibleIndex = input.selectedIndex - input.scrollOffset;
  if (visibleIndex < 0 || visibleIndex >= input.maxVisibleItems) {
    return undefined;
  }
  const nameY = visibleIndex * input.linesPerItem;
  return {
    descriptionY: input.showDescription ? nameY + input.fontHeight : undefined,
    name: `  ${input.selectedOption.name}`,
    nameY,
  };
}

export class FocusAwareSelectRenderable extends SelectRenderable {
  protected override renderSelf(
    buffer: OptimizedBuffer,
    deltaTime: number,
  ): void {
    super.renderSelf(buffer, deltaTime);
    this.hideSelectionArrowWhenBlurred();
  }

  private hideSelectionArrowWhenBlurred(): void {
    if (this.focused || this.frameBuffer === null) {
      return;
    }
    const state = this as unknown as FocusAwareSelectPrivateState;
    if (state._options.length === 0 || state._font !== undefined) {
      return;
    }
    const selectedOption = state._options[state._selectedIndex];
    if (selectedOption === undefined) {
      return;
    }
    const redrawTarget = resolveBlurredSelectRedrawTarget({
      fontHeight: state.fontHeight,
      linesPerItem: state.linesPerItem,
      maxVisibleItems: state.maxVisibleItems,
      scrollOffset: state.scrollOffset,
      selectedIndex: state._selectedIndex,
      selectedOption,
      showDescription: state._showDescription,
    });
    if (redrawTarget === undefined || redrawTarget.nameY >= this.height) {
      return;
    }
    this.frameBuffer.fillRect(
      0,
      redrawTarget.nameY,
      this.width,
      Math.min(state.linesPerItem, this.height - redrawTarget.nameY),
      state._backgroundColor,
    );
    this.frameBuffer.drawText(
      redrawTarget.name,
      1,
      redrawTarget.nameY,
      state._textColor,
    );
    if (
      redrawTarget.descriptionY !== undefined &&
      redrawTarget.descriptionY < this.height
    ) {
      this.frameBuffer.drawText(
        selectedOption.description,
        3,
        redrawTarget.descriptionY,
        state._descriptionColor,
      );
    }
  }
}

export function popupBackgroundColor(): string {
  return "#0d141b";
}

export function focusOpenTuiTarget(target: OpenTuiFocusableTarget): void {
  target.focus();
}

export const selectJkBindings = [
  { name: "j", action: "move-down" as const },
  { name: "k", action: "move-up" as const },
] as const;

export type ShortcutKeyEvent = Pick<
  KeyEvent,
  "ctrl" | "meta" | "name" | "shift"
>;
