// The shape every settings page is made of: a titled group of rows, each
// row a name, one line of why, and its control on the right.
//
// One pattern on purpose. Settings is read more than it is changed, and a
// page where every block is its own card with its own heading makes the
// eye re-learn the layout each time; rows in a group read like a list.
import { cn } from "@/lib/cn";
import { InfoTip } from "@/components/ui/info-tip";

export function SettingsPageHeader({ title, description }: { title: string; description?: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="text-balance text-[22px] font-semibold tracking-[-0.01em] text-foreground">{title}</h1>
      {description && <p className="mt-1 text-pretty text-[13px] text-muted-foreground">{description}</p>}
    </div>
  );
}

export function SettingsGroup({
  title,
  children,
  className,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mb-6", className)}>
      {title && (
        <h2 className="mb-2 px-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{title}</h2>
      )}
      <div className="flex flex-col divide-y overflow-hidden rounded-2xl border bg-card">{children}</div>
    </section>
  );
}

export function SettingRow({
  label,
  description,
  info,
  control,
  children,
  htmlFor,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  info?: string;
  /** Sits on the right, vertically centred on the label block. */
  control?: React.ReactNode;
  /** Anything that belongs under the row: an error, an expanded editor. */
  children?: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="px-4 py-3.5">
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <label htmlFor={htmlFor} className="flex items-center gap-1.5 text-[13.5px] font-medium text-foreground">
            {label}
            {info && <InfoTip text={info} />}
          </label>
          {description && (
            <div className="mt-0.5 text-pretty text-[12.5px] leading-relaxed text-muted-foreground">{description}</div>
          )}
        </div>
        {control && <div className="shrink-0">{control}</div>}
      </div>
      {children}
    </div>
  );
}
