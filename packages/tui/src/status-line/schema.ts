/** Status line segment identifiers accepted by custom status-line settings. */
export const STATUS_LINE_SEGMENT_IDS = [
	"pi",
	"status",
	"model",
	"mode",
	"path",
	"git",
	"pr",
	"subagents",
	"token_in",
	"token_out",
	"token_total",
	"token_rate",
	"cost",
	"context_pct",
	"context_total",
	"time_spent",
	"time",
	"session",
	"hostname",
	"cache_read",
	"cache_write",
	"cache_hit",
	"session_name",
	"usage",
	"collab",
	"stream",
	"vim",
] as const;

/** One identifier from the supported status-line segment catalog. */
export type StatusLineSegmentId = (typeof STATUS_LINE_SEGMENT_IDS)[number];

/**
 * Baseline segments used when Custom is selected without segment overrides.
 * Fork default (omp t-489b1a44): Custom is the default preset, so these are
 * the bar a bare install shows. `status` renders extension setStatus text and
 * stays empty without an extension.
 */
export const CUSTOM_STATUS_LINE_DEFAULTS: {
	readonly left: StatusLineSegmentId[];
	readonly right: StatusLineSegmentId[];
} = {
	left: ["status", "model", "context_pct", "mode", "subagents"],
	right: ["session_name", "usage", "cost"],
};

export const CONTEXT_LINE_MODE_VALUES = ["off", "percentage", "annotated", "embedded"] as const;
export type ContextLineMode = (typeof CONTEXT_LINE_MODE_VALUES)[number];
export const STATUS_LINE_PRESET_VALUES = ["default", "minimal", "compact", "full", "nerd", "ascii", "custom"] as const;
export type StatusLinePreset = (typeof STATUS_LINE_PRESET_VALUES)[number];
export const STATUS_LINE_SEPARATOR_VALUES = [
	"powerline",
	"powerline-thin",
	"slash",
	"pipe",
	"block",
	"none",
	"ascii",
] as const;
export type StatusLineSeparatorStyle = (typeof STATUS_LINE_SEPARATOR_VALUES)[number];
