"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { Button, IconButton, Select } from "@primer/react";
import { GearIcon, InfoIcon } from "@primer/octicons-react";
import { ClipboardCheck, Database, FileText, Info, Languages, PencilLine, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { WorkbenchDialog } from "./WorkbenchDialog";
import { WORKBENCH_SKILLS, defaultSkillOptions, normalizeSkillDefaults } from "../lib/workbench-skills.mjs";

export type SkillOptions = {
  id: string;
  scope: "selection" | "paper" | "resources";
  audience: "specialist" | "adjacent" | "general";
  length: "preserve" | "shorter" | "expand";
  english: "preserve" | "US" | "UK" | "CA";
  resourcePaths?: string;
  outputPath?: string;
};

export const DEFAULT_SKILL_OPTIONS = defaultSkillOptions() as SkillOptions;
const DEFAULTS_EVENT = "workbench-skill-defaults";
const NORMAL_HELP = "Your agent can read relevant local results and code during ordinary chat; no inspection skill needs to be selected first. It is instructed to cite evidence and disclose samples or missing data. This is guidance, not guaranteed validation. Ordinary review and permission rules apply.";
const ICONS = [PencilLine, ClipboardCheck, Languages, Database, FileText];
const scopeLabel = (scope: string) => scope === "paper" ? "Whole paper" : scope === "resources" ? "Local data files" : "Selected passage";
function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(DEFAULTS_EVENT, listener);
  return () => { window.removeEventListener("storage", listener); window.removeEventListener(DEFAULTS_EVENT, listener); };
}

export function SkillControls({ value, onChange, disabled, hasSelection, settingsKey }: {
  value: SkillOptions;
  onChange: (value: SkillOptions) => void;
  disabled: boolean;
  hasSelection: boolean;
  settingsKey: string;
}) {
  const storageKey = `lattice:skill-defaults:v2:${settingsKey}`;
  const stored = useSyncExternalStore(subscribe, () => {
    try { return localStorage.getItem(storageKey) ?? ""; } catch { return ""; }
  }, () => "");
  const defaults = useMemo(() => {
    try { return normalizeSkillDefaults(JSON.parse(stored)) as Record<string, SkillOptions>; }
    catch { return normalizeSkillDefaults(null) as Record<string, SkillOptions>; }
  }, [stored]);
  const [draft, setDraft] = useState<Record<string, SkillOptions> | null>(null);
  const [editingId, setEditingId] = useState(WORKBENCH_SKILLS[0].id);
  const [help, setHelp] = useState<{ label: string; text: string; readOnly?: boolean } | null>(null);
  const [saveError, setSaveError] = useState("");
  const [saveNotice, setSaveNotice] = useState("");
  const selected = WORKBENCH_SKILLS.find(skill => skill.id === value.id);
  const editing = WORKBENCH_SKILLS.find(skill => skill.id === editingId)!;
  const options = draft?.[editingId];
  const close = () => setDraft(null);
  const edit = (changes: Partial<SkillOptions>) => setDraft(current => current ? {
    ...current, [editingId]: { ...current[editingId], ...changes },
  } : current);
  const save = () => {
    try {
      const normalized = normalizeSkillDefaults(draft) as Record<string, SkillOptions>;
      localStorage.setItem(storageKey, JSON.stringify(normalized));
      window.dispatchEvent(new Event(DEFAULTS_EVENT));
      if (value.id) onChange(normalized[value.id]);
      setSaveNotice("Skill settings saved for this paper in this browser.");
      close();
    } catch { setSaveError("Settings could not be saved. Free some browser storage, then try Save settings again."); }
  };
  const missingSelection = selected && value.scope === "selection" && !hasSelection;
  const missingData = selected && value.scope === "resources" && !value.resourcePaths?.trim();

  return <>
    <div className="skill-controls">
      <div className="skill-toolbar">
        <label className="skill-picker"><span className="sr-only">Skill</span>
          <SlidersHorizontal size={15} aria-hidden="true" />
          <Select aria-label="Workbench skill" value={value.id} disabled={disabled}
            onChange={event => { onChange(event.target.value ? defaults[event.target.value] : DEFAULT_SKILL_OPTIONS); setSaveNotice(""); }}>
            <option value="">Normal chat</option>
            {WORKBENCH_SKILLS.map(skill => <option key={skill.id} value={skill.id}>{skill.label}</option>)}
          </Select>
        </label>
        <IconButton type="button" icon={InfoIcon} variant="invisible" aria-label={`About ${selected?.label ?? "Normal chat"}`}
          title="About this skill" aria-haspopup="dialog"
          onClick={() => setHelp({ label: selected?.label ?? "Normal chat", text: selected?.description ?? NORMAL_HELP, readOnly: selected?.readOnly })} />
        <IconButton type="button" icon={GearIcon} variant="invisible" className="skill-settings-button" disabled={disabled} aria-label="Skill settings"
          title="Skill settings" aria-haspopup="dialog" onClick={() => {
            setDraft({ ...defaults, ...(value.id ? { [value.id]: value } : {}) });
            setEditingId(value.id || WORKBENCH_SKILLS[0].id); setSaveError("");
          }} />
      </div>
      {selected ? <p className={`skill-context${missingSelection || missingData ? " needs-input" : ""}`} role="status">
        {selected.readOnly ? <ShieldCheck size={13} aria-hidden="true" /> : <PencilLine size={13} aria-hidden="true" />}
        <span>{missingSelection ? "Select a passage to continue." : missingData ? "Add data files in Skill settings."
          : `${scopeLabel(value.scope)} · ${selected.readOnly ? "Read-only" : "Reviewable edits"}`}</span>
      </p> : null}
      <span className="sr-only" role="status">{saveNotice}</span>
    </div>

    <WorkbenchDialog open={Boolean(draft)} title="Skill settings" className="skill-settings-dialog" onClose={close}
      description="Set the defaults for this paper. Your model and approval choices stay unchanged."
      footer={<>
        <Button type="button" variant="invisible" onClick={() => { setDraft(normalizeSkillDefaults(null) as Record<string, SkillOptions>); setSaveError(""); }}>Reset defaults</Button>
        <div className="dialog-footer-actions"><Button type="button" onClick={close}>Cancel</Button>
          <Button type="button" variant="primary" onClick={save} disabled={disabled}>Save settings</Button></div>
      </>}>
      {draft && options ? <div className="skill-settings-layout">
        <nav className="skill-settings-nav" aria-label="Skill settings sections">
          {WORKBENCH_SKILLS.map((skill, index) => {
            const Icon = ICONS[index];
            return <button type="button" key={skill.id} aria-pressed={editingId === skill.id} onClick={() => setEditingId(skill.id)}>
              <Icon size={17} aria-hidden="true" /><span>{skill.label}<small>{skill.readOnly ? "Read-only" : "Reviewable edits"}</small></span>
            </button>;
          })}
          <p>Saved for this paper,<br />in this browser only.</p>
        </nav>
        <label className="skill-settings-mobile-picker">Configure skill
          <Select value={editingId} onChange={event => setEditingId(event.target.value)}>
            {WORKBENCH_SKILLS.map(skill => <option key={skill.id} value={skill.id}>{skill.label}</option>)}
          </Select>
        </label>
        <section className="skill-settings-detail" aria-labelledby="skill-detail-title">
          <div className="skill-detail-heading"><h3 id="skill-detail-title">{editing.label}</h3>
            <button type="button" className="icon-button" aria-label={`About ${editing.label} settings`} title="What this skill does" aria-haspopup="dialog"
              onClick={() => setHelp({ label: editing.label, text: editing.description, readOnly: editing.readOnly })}><Info size={18} aria-hidden="true" /></button>
          </div>
          <p className="skill-detail-description">{editing.description}</p>
          <div className="skill-settings-fields">
            {editing.scopes.length > 1 ? <label>Scope
              <Select aria-label={`${editing.label} scope`} value={options.scope} onChange={e => edit({ scope: e.target.value as SkillOptions["scope"] })}>
                {editing.scopes.map(scope => <option key={scope} value={scope}>{scopeLabel(scope)}</option>)}
              </Select>
            </label> : null}
            {["polish-selection", "generate-report"].includes(editing.id) ? <label>Audience
              <Select aria-label={`${editing.label} audience`} value={options.audience} onChange={e => edit({ audience: e.target.value as SkillOptions["audience"] })}>
                <option value="specialist">Specialists</option><option value="adjacent">Adjacent field</option><option value="general">General readers</option>
              </Select>
            </label> : null}
            {editing.id === "polish-selection" ? <label>Length
              <Select aria-label="Polish selection length" value={options.length} onChange={e => edit({ length: e.target.value as SkillOptions["length"] })}>
                <option value="preserve">Keep length</option><option value="shorter">Shorten</option><option value="expand">Expand notes</option>
              </Select>
            </label> : null}
            {["polish-selection", "english-consistency"].includes(editing.id) ? <label>English spelling
              <Select aria-label={`${editing.label} spelling`} value={options.english} onChange={e => edit({ english: e.target.value as SkillOptions["english"] })}>
                {editing.id === "polish-selection" ? <option value="preserve">Keep spelling</option> : null}
                <option value="US">American</option><option value="UK">British</option><option value="CA">Canadian</option>
              </Select>
            </label> : null}
            {editing.scope === "resources" ? <label className="skill-settings-wide">Data files
              <textarea aria-label={`${editing.label} data files`} placeholder={"results/metrics.json\nresults/summary.csv"} rows={4} maxLength={8000}
                value={options.resourcePaths} onChange={e => edit({ resourcePaths: e.target.value })} />
              <small>One research-folder-relative path per line, up to five. CSV, TSV, JSON, JSONL, numeric NPY. Previews are limited to 1 MiB per file and enter your selected subscription agent’s context.</small>
            </label> : null}
            {editing.id === "generate-report" ? <label className="skill-settings-wide">Markdown output path
              <input aria-label="Results report output path" value={options.outputPath} maxLength={1000} onChange={e => edit({ outputPath: e.target.value })} />
              <small>Only this .md file can change; its parent folder must already exist. Replacing an existing report follows your approval setting.</small>
            </label> : null}
          </div>
          <div className="skill-settings-note"><ShieldCheck size={16} aria-hidden="true" /><p>Saving changes preferences only. It does not run a skill, edit your paper, or enable auto-approval.</p></div>
          {saveError ? <p className="dialog-error" role="alert">{saveError}</p> : null}
        </section>
      </div> : null}
    </WorkbenchDialog>

    <WorkbenchDialog open={Boolean(help)} title={`About ${help?.label ?? "this skill"}`} className="skill-info-dialog" onClose={() => setHelp(null)}
      footer={<Button type="button" onClick={() => setHelp(null)}>Got it</Button>}>
      <div className="skill-info-content"><p>{help?.text}</p>
        <div className="skill-info-policy"><ShieldCheck size={18} aria-hidden="true" /><div>
          <strong>{help?.readOnly ? "Read-only by design" : "Your approval settings still apply"}</strong>
          <p>{help?.readOnly ? "This skill cannot apply file changes, even when auto-approval is on." : "Proposed edits follow the existing review, auto-approval, and Undo flow. This skill grants no additional permissions."}</p>
        </div></div>
        <p className="skill-info-footnote">Skill defaults are available from the gear beside the skill selector. Model judgments still need author review.</p>
      </div>
    </WorkbenchDialog>
  </>;
}
