/**
 * Settings — adapters + app preferences. Read-only this iteration: values come
 * from `/api/settings`; nothing here starts or controls a run.
 *
 * The one live control is the language switch — a pure presentation preference,
 * not a run control, so it stays consistent with the read-only invariant.
 */
import { getLang, t } from "../i18n";
import type { SettingsSnapshot } from "../types";
import { esc } from "../util";

function setRow(title: string, sub: string, control: string): string {
  const subClass = sub.startsWith("/") || sub.startsWith("~") || sub.startsWith(".") ? "path" : "d";
  return (
    `<div class="setrow"><div class="body"><h4>${title}</h4>` +
    (sub ? `<div class="${subClass}">${esc(sub)}</div>` : "") +
    `</div>${control}</div>`
  );
}

function toggle(on: boolean): string {
  return `<span class="toggle ${on ? "" : "off"}"><i></i></span>`;
}

/** Segmented EN / 中文 switch. Click handling lives in main.ts (`[data-lang]`). */
function langControl(): string {
  const cur = getLang();
  return (
    `<span class="subtabs" style="flex:none;">` +
    `<b class="${cur === "en" ? "on" : ""}" data-lang="en">EN</b>` +
    `<b class="${cur === "zh" ? "on" : ""}" data-lang="zh">中文</b>` +
    `</span>`
  );
}

export function renderSettings(settings: SettingsSnapshot | null): string {
  const adapterRows = (settings?.adapters ?? [])
    .map((a) => {
      const title = a.installed
        ? `${esc(a.label)}${
            a.isDefault
              ? ` <span style="font-weight:400;color:var(--green-deep);font-size:12px;">· ${t("default")}</span>`
              : ""
          }`
        : `<span style="color:var(--muted)">${esc(a.label)} <span style="color:var(--faint);font-weight:400;">· ${t("not found")}</span></span>`;
      return setRow(
        title,
        `${a.command} · ${a.permissionNote}`,
        `<span class="btn secondary sm">${a.installed ? t("available") : t("missing")}</span>`,
      );
    })
    .join("");
  const roots = settings?.workflowRoots
    .map((r) => setRow(`${r.label} · ${r.provider}`, r.path, ""))
    .join("");

  return (
    `<div class="content">` +
    `<h1 class="page-h1">${t("Settings")}</h1>` +
    `<p class="page-sub">${t("CLI adapters and app preferences. The client never starts runs — these only tell it how to read and which CLIs exist.")}</p>` +
    `<div style="display:grid;grid-template-columns:1fr 1fr;gap:44px;margin-top:24px;">` +
    `<div><div class="section-label" style="margin:0 0 6px;">${t("Adapters")}</div>${adapterRows || `<div class="empty" style="position:static;min-height:160px;">${t("Loading settings...")}</div>`}</div>` +
    `<div>` +
    `<div class="section-label" style="margin:0 0 6px;">${t("Reading")}</div>` +
    setRow(t("Run directory"), settings?.runsRoot ?? t("Loading settings..."), "") +
    setRow(t("Current project"), settings?.cwd ?? "", "") +
    setRow(t("Config file"), settings?.configPath ?? t("built-in defaults"), "") +
    `<div class="section-label" style="margin:22px 0 6px;">${t("Workflow directories")}</div>` +
    (roots || `<div class="empty" style="position:static;min-height:120px;">${t("Loading settings...")}</div>`) +
    `<div class="section-label" style="margin:22px 0 6px;">${t("App")}</div>` +
    setRow(t("Language"), t("switch the interface language"), langControl()) +
    setRow(t("Launch at login"), t("keep watching runs in the background"), toggle(true)) +
    setRow(t("Dock badge — active run count"), "", toggle(true)) +
    setRow(t("Native notification on run finish / fail"), "", toggle(true)) +
    setRow(t("Notify only on failure"), "", toggle(false)) +
    `</div>` +
    `</div>` +
    `<div class="note-banner"><span style="font-family:var(--mono);color:var(--green-deep);">ⓘ</span> ${t("Runs start from your agent via {cmd}. Claude Code runs stay strictly read-only.", { cmd: "<code>odw run &lt;name&gt;</code>" })}</div>` +
    `</div>`
  );
}
