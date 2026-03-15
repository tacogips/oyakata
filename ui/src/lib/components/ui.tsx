import { splitProps, type JSX, type ParentProps } from "solid-js";

type ButtonVariant = "default" | "secondary" | "outline" | "ghost";
type BadgeVariant = "default" | "secondary" | "outline" | "destructive";

function joinClasses(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter(Boolean).join(" ");
}

export interface ButtonProps
  extends ParentProps<
    Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "class">
  > {
  readonly class?: string;
  readonly variant?: ButtonVariant;
}

export function Button(props: ButtonProps): JSX.Element {
  const [local, others] = splitProps(props, ["children", "class", "variant"]);

  return (
    <button
      {...others}
      class={joinClasses(
        "ui-button",
        `ui-button--${local.variant ?? "default"}`,
        local.class,
      )}
    >
      {local.children}
    </button>
  );
}

export interface BadgeProps extends ParentProps {
  readonly class?: string;
  readonly variant?: BadgeVariant;
}

export function Badge(props: BadgeProps): JSX.Element {
  return (
    <span
      class={joinClasses(
        "ui-badge",
        `ui-badge--${props.variant ?? "default"}`,
        props.class,
      )}
    >
      {props.children}
    </span>
  );
}

export interface StatCardProps {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}

export function StatCard(props: StatCardProps): JSX.Element {
  return (
    <article class="stat-card">
      <span class="stat-card__label">{props.label}</span>
      <strong class="stat-card__value">{props.value}</strong>
      <span class="stat-card__detail">{props.detail}</span>
    </article>
  );
}
