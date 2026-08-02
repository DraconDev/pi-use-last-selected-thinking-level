import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// =============================================================================
// use-last-selected-thinking-level
//
// pi keeps a single session-global thinking level: switching models only
// inherits the current level, unless a settings pin (enabledModels pattern
// such as `*luna*:max`) overrides it. There is no per-model memory.
//
// This extension remembers the thinking level each model last ran at (or was
// last explicitly set to) and re-applies it when you come back to that model:
//
//   - thinking_level_select records the effective level for the active model,
//     and the outgoing model's level when a switch changed it.
//   - model_select re-applies the remembered level for the incoming model.
//   - session start (startup / new) re-applies the remembered level for the
//     active model; resume/fork keep the session's own stored level.
//   - Settings pins always win: a model pinned via enabledModels keeps its
//     pinned level; its memory stays dormant until the pin is removed.
//
// State persists in ~/.pi/agent/thinking-memory.json.
//
// Ordering notes (verified against pi's agent-session flow): on a model switch
// pi sets the new model first, then (re)clamps the level — so by the time
// thinking_level_select fires, ctx.model already points at the NEW model while
// event.previousLevel is the level the OLD model was running at. model_select
// fires after. All handlers below are fully synchronous, so the runner's event
// order (switch-clamp TLS -> model_select -> our re-emitted TLS) is
// deterministic and nothing can interleave.
// =============================================================================

const STATE_FILE = join(getAgentDir(), "thinking-memory.json");
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** session_start reasons where the remembered level is re-applied to the active model. */
const APPLY_REASONS = new Set(["startup", "new"]);

/** "provider/modelId" -> last thinking level for that model. */
let levels: Record<string, ThinkingLevel> = {};
let loaded = false;
/**
 * The model we believe is active. ctx.model switches to the new model before
 * model_select fires, so this lets thinking_level_select attribute a change to
 * the model being left (previousLevel) vs. the model that is active.
 */
let lastModelKey: string | undefined;
/** Serializes state-file writes (writes are synchronous inside the chain). */
let writeChain: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function modelKey(model: { provider: string; id: string } | undefined): string | undefined {
	if (!model) return undefined;
	return `${model.provider}/${model.id}`;
}

/** True when a settings pattern (enabledModels / --models) pins a thinking level for this model. */
function isPinned(ctx: ExtensionContext, key: string): boolean {
	return ctx.scopedModels.some(
		(scoped) => scoped.thinkingLevel !== undefined && modelKey(scoped.model) === key,
	);
}

function load(): void {
	if (loaded) return;
	loaded = true;
	try {
		if (!existsSync(STATE_FILE)) return;
		const parsed: unknown = JSON.parse(readFileSync(STATE_FILE, "utf8"));
		if (!isRecord(parsed) || !isRecord(parsed.levels)) return;
		for (const [key, value] of Object.entries(parsed.levels)) {
			if (key.includes("/") && isThinkingLevel(value)) levels[key] = value;
		}
	} catch (error) {
		console.warn(`[thinking-memory] could not load ${STATE_FILE}: ${error}`);
	}
}

function persist(): void {
	const payload = `${JSON.stringify({ version: 1, levels }, null, 2)}\n`;
	writeChain = writeChain.then(() => {
		const tmp = `${STATE_FILE}.tmp-${process.pid}`;
		try {
			mkdirSync(dirname(STATE_FILE), { recursive: true });
			writeFileSync(tmp, payload, "utf8");
			renameSync(tmp, STATE_FILE);
		} catch (error) {
			console.warn(`[thinking-memory] could not write ${STATE_FILE}: ${error}`);
		}
	});
}

function remember(key: string, level: ThinkingLevel): void {
	load();
	if (levels[key] === level) return;
	levels[key] = level;
	persist();
}

function applyRemembered(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	key: string,
	notify: boolean,
): void {
	load();
	const remembered = levels[key];
	if (remembered === undefined) return;
	const before = pi.getThinkingLevel();
	pi.setThinkingLevel(remembered);
	const after = pi.getThinkingLevel();
	if (notify && after !== before) {
		ctx.ui.notify(`Applied remembered thinking level '${remembered}' to ${key}`, "info");
	}
}

export default function (pi: ExtensionAPI) {
	// Re-establish in-memory state per session and (for startup/new) apply the
	// remembered level of the session's active model.
	pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
		load();
		lastModelKey = modelKey(ctx.model);
		if (lastModelKey && APPLY_REASONS.has(event.reason)) {
			if (!isPinned(ctx, lastModelKey)) applyRemembered(pi, ctx, lastModelKey, false);
		}
	});

	// Record level changes. On a model switch this fires before model_select and
	// with ctx.model already set to the new model — attribute previousLevel to
	// the outgoing model instead of recording the switch's clamp/pin for the
	// incoming one.
	pi.on("thinking_level_select", async (event, ctx) => {
		const current = modelKey(ctx.model);
		if (!current) return;
		load();
		if (lastModelKey === undefined) {
			// First observation (e.g. level restore during session load): nothing to record yet.
			lastModelKey = current;
			return;
		}
		if (current !== lastModelKey) {
			remember(lastModelKey, event.previousLevel);
			lastModelKey = current;
			return;
		}
		// Same model: a deliberate selection (settings, keybinding, pi.setThinkingLevel).
		remember(current, event.level);
	});

	// Re-apply the incoming model's remembered level on user-initiated switches.
	// Pinned models are skipped: settings pins always win.
	pi.on("model_select", async (event, ctx) => {
		const key = modelKey(event.model);
		lastModelKey = key;
		if (!key || event.source === "restore") return;
		if (isPinned(ctx, key)) return;
		applyRemembered(pi, ctx, key, true);
	});

	// Inspect / clear the memory.
	pi.registerCommand("thinking-memory", {
		description:
			"Show remembered per-model thinking levels; 'clear' or 'clear <fragment>' forgets them",
		handler: async (args: string | undefined, ctx: ExtensionCommandContext) => {
			load();
			const entries = Object.entries(levels).sort(([a], [b]) => a.localeCompare(b));
			const arg = (args ?? "").trim();
			if (arg === "clear") {
				levels = {};
				persist();
				ctx.ui.notify("Cleared all remembered thinking levels", "info");
				return;
			}
			if (arg.startsWith("clear ")) {
				const fragment = arg.slice("clear ".length).trim().toLowerCase();
				const removed = entries.filter(([key]) => key.toLowerCase().includes(fragment));
				if (removed.length === 0) {
					ctx.ui.notify(`No remembered levels match '${fragment}'`, "info");
					return;
				}
				for (const [key] of removed) delete levels[key];
				persist();
				ctx.ui.notify(`Cleared ${removed.length} remembered level(s)`, "info");
				return;
			}
			if (entries.length === 0) {
				ctx.ui.notify(
					"No remembered thinking levels yet — change a model's thinking level to record it",
					"info",
				);
				return;
			}
			const currentKey = modelKey(ctx.model);
			const lines = entries.map(([key, level]) => {
				const marker = key === currentKey ? "  (current)" : "";
				const pinNote = isPinned(ctx, key) ? "  [pinned by settings — dormant]" : "";
				return `  ${key}: ${level}${marker}${pinNote}`;
			});
			ctx.ui.notify(
				`Remembered thinking levels:\n${lines.join("\n")}\nFile: ${STATE_FILE}`,
				"info",
			);
		},
	});
}
