import { A as RaccoonCredentialStore, C as activeBadges, D as parseModelCatalog, E as multiplierLabel, M as parseDesktopAuth, O as resolveVision, S as RaccoonCatalogStore, T as isRateUnknown, _ as resolveClientIdentity, a as RACCOON_PROBE_PATH, b as MEASURED_VISION, c as RaccoonUpstreamClient, d as probeFingerprint, f as clearHostHeartbeat, g as writeHostHeartbeat, i as variantFor, j as decodeJwtClaims, k as supportsVision, l as classifyUpstreamError, n as ALL_VARIANTS, o as RACCOON_STATUS_PATH, r as RACCOON_PRIMARY, s as KIND_STATUS, t as RACCOON_CONNECT_VERSION, u as RaccoonProbeStore, v as userDataCandidates, w as isFree, x as RaccoonCatalog, y as FALLBACK_CATALOG } from "./version-D0hZvsYE.js";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createServer } from "node:http";
import { Readable } from "node:stream";
//#region src/adapter.ts
/** Provider idle ceiling while one stream read is outstanding. */
const RACCOON_STREAM_IDLE_TIMEOUT_MS = 3e5;
/**
* Image-request budgets at the dsh-llm-pi-ai defaults (the profile type made
* them required in 0.1.1-rc.2). They bound requests to models whose image-input
* verdict ({@link supportsVision}, measured rather than tag-governed) says they
* read images; the rest are described as text-only to pi-ai, so an image never
* reaches them in the first place.
*/
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576
};
/**
* Inert pi-ai auth plane.
*
* The route authenticates solely through the shim's per-process shared secret,
* which `resolveApiKey` supplies, so pi-ai's own credential lifecycle and
* ambient discovery must never manufacture state for it. `PiAiAdapterOptions.auth`
* is required since 0.1.1-rc.2, so every ambient question is answered as
* "nothing stored, nothing set" rather than left to pi-ai's in-memory default.
*/
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-raccoon-connect: the raccoon route has no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/** Subscription-style billing: per-token pricing is unknowable, so report zero. */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/** Separator between a model's name and its display suffix. */
const RATE_SEPARATOR = " · ";
/**
* The catalog display suffix: rate, then promotion badges.
*
* `x0.00` and `限时免费` are the upstream's own numbers and labels. A row whose
* only price came from an expired promotion contributes nothing here — the card
* says "价格未知", but silently dropping a stale figure from the picker is better
* than continuing to advertise a price nobody is paying.
*/
function displaySuffix(model, now) {
	const parts = [];
	if (!isRateUnknown(model)) {
		const rate = multiplierLabel(model);
		if (rate !== void 0) parts.push(rate);
	}
	parts.push(...activeBadges(model, now));
	return parts.length === 0 ? void 0 : parts.join(RATE_SEPARATOR);
}
/** Append the catalog display suffix to one model's display name. */
function withCatalogDisplay(model, now) {
	const base = model.label === "" ? model.id : model.label;
	const suffix = displaySuffix(model, now);
	return suffix === void 0 ? base : `${base}${RATE_SEPARATOR}${suffix}`;
}
/**
* Resolve one model's reasoning capability into pi-ai's `thinkingLevelMap`.
*
* The 小浣熊 catalog declares no effort vocabulary, so the only source is a
* user-authorized local probe. Two rules keep an observation from being
* over-read:
*
* - a `non-validating` observation yields **no** control at all: that upstream
*   accepted a value that cannot exist, so every per-level answer it could give
*   would be a false positive;
* - `off` is never offered. Disabling thinking is a separate capability, and no
*   amount of accepting other values proves it.
*
* The offered set means "the upstream did not reject this spelling", not "this
* measurably changes what the model does".
*/
function reasoningFields(observed) {
	if (observed === void 0 || observed.validation !== "validating" || observed.efforts.length === 0) return { reasoning: false };
	const has = (level) => observed.efforts.includes(level);
	return {
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: has("low") ? "low" : null,
			medium: has("medium") ? "medium" : null,
			high: has("high") ? "high" : null,
			xhigh: has("xhigh") ? "xhigh" : null,
			max: has("max") ? "max" : null
		}
	};
}
/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(model, baseUrl, now, observed, providerId = "raccoon") {
	return {
		id: model.id,
		name: withCatalogDisplay(model, now),
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: supportsVision(model) ? ["text", "image"] : ["text"],
		...reasoningFields(observed),
		cost: NO_COST,
		contextWindow: model.contextWindow ?? 32768,
		maxTokens: model.maxTokens ?? 8192,
		compat: { maxTokensField: "max_tokens" }
	};
}
/**
* Assemble the adapter.
*
* `getModels` is delegated to a live catalog read, so stream dispatch runs
* through the constructed provider while the catalog answer tracks the upstream
* refresh. `baseUrl` is re-resolved per read because the shim's port is
* ephemeral and the provider is built once.
*/
function createRaccoonAdapter(options) {
	const { shim, catalog, resolveAttachments, observe } = options;
	const now = () => /* @__PURE__ */ new Date();
	const buildModels = () => {
		const baseUrl = `${shim.baseUrl()}/v1`;
		const stamp = now();
		return catalog.current().map((model) => toPiModel(model, baseUrl, stamp, observe?.(model.id), options.providerId));
	};
	const provider = {
		...createProvider({
			id: options.providerId,
			name: options.displayName,
			auth: { apiKey: {
				name: "小浣熊 OAuth bearer token",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: "小浣熊"
					};
				}
			} },
			models: buildModels(),
			api: openAICompletionsApi()
		}),
		getModels: () => buildModels()
	};
	const profile = {
		provider: options.providerId,
		displayName: options.displayName,
		streamIdleTimeoutMs: RACCOON_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(void 0, "dsh-raccoon-connect retryPolicy"),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider
	};
	let profiles = /* @__PURE__ */ new Map([[options.providerId, profile]]);
	return {
		adapter: new RaccoonPiAiAdapter(catalog, {
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => shim.token(),
			...resolveAttachments === void 0 ? {} : { resolveAttachments }
		}),
		invalidate: () => {
			profiles = /* @__PURE__ */ new Map([[options.providerId, profile]]);
		}
	};
}
/**
* `PiAiAdapter` with the billing rate folded into the catalog answers the DSH
* pickers see.
*
* Both overrides delegate to `super` and rewrite display fields only, so
* streaming, capability resolution, and effort mapping stay exactly as
* `dsh-llm-pi-ai` implements them. A model missing from the catalog falls
* through untouched rather than being dropped: catalog membership is advisory
* and the seam tolerates serving an unlisted id.
*/
var RaccoonPiAiAdapter = class extends PiAiAdapter {
	catalog;
	constructor(catalog, options) {
		super(options);
		this.catalog = catalog;
	}
	infoFor(model) {
		return this.catalog.current().find((entry) => entry.id === model);
	}
	async listModels(provider) {
		const models = await super.listModels(provider);
		const now = /* @__PURE__ */ new Date();
		return models.map((model) => {
			const info = this.infoFor(model.id);
			if (info === void 0) return model;
			return {
				...model,
				name: withCatalogDisplay(info, now)
			};
		});
	}
	async resolveModel(provider, model, signal) {
		const resolved = await super.resolveModel(provider, model, signal);
		const info = this.infoFor(model);
		if (info === void 0) return resolved;
		return {
			...resolved,
			name: withCatalogDisplay(info, /* @__PURE__ */ new Date())
		};
	}
};
//#endregion
//#region src/probe.ts
/**
* The reasoning-effort probe protocol: what a single sweep does, in what order,
* and what each answer is allowed to mean.
*
* The upstream catalog declares no effort vocabulary for 小浣熊's models, and a
* request returning HTTP 200 proves nothing about whether the gateway *honored*
* `reasoning_effort` — a server that ignores an unknown value answers normally.
* So capability is established by experiment, and the experiment has to rule out
* being meaningless before its per-level answers count:
*
* 1. **baseline** — no `reasoning_effort` at all. If that fails, nothing was
*    learned about the parameter and the whole run is `unknown`.
* 2. **sentinel** — a value that cannot exist (`probe_sentinel_<24 hex>`). If the
*    upstream *accepts* it, the upstream does not validate the field, so every
*    per-level answer it could give would be a false positive: the run stops as
*    `non-validating` and yields no picker control.
* 3. **levels** — only once validation is proven, each canonical level is tested
*    for acceptance.
*
* Any answer that is neither "accepted" nor "a decisive refusal" voids the run to
* `unknown`: a sweep never guesses from silence. Probing spends credit, so it is
* only ever started by an explicit user action, and a transient `unknown` must
* not overwrite an earlier decisive record — that rule lives in the store.
*
* @module dsh-raccoon-connect/probe
*/
/** Levels worth testing, in the order the picker shows them. */
const PROBE_LEVELS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/**
* Business codes and phrases the 小浣熊 gateway answers with when it rejects a
* request parameter.
*
* The gateway reports parameter problems as `100002 / params_invalid_error`
* (observed while probing the refresh endpoint with a misspelled field name —
* see `docs/upstream-protocol.md` §2), which is the decisive "this upstream
* validates what it is given" signal. Anything else that arrives as a 400 is
* treated as silence, not as a refusal, because an unrelated validation failure
* would otherwise be read as proof the field is checked.
*/
const REFUSAL_CODES = /* @__PURE__ */ new Set(["100002"]);
const REFUSAL_PHRASES = [
	"params_invalid",
	"invalid_reasoning_effort",
	"reasoning_effort"
];
/** Whether one attempt is a decisive refusal of the submitted value. */
function isRefusal(attempt) {
	if (attempt.status !== 400) return false;
	if (attempt.errorCode !== void 0 && REFUSAL_CODES.has(attempt.errorCode)) return true;
	const message = (attempt.message ?? "").toLowerCase();
	return REFUSAL_PHRASES.some((phrase) => message.includes(phrase.toLowerCase()));
}
/** Whether an attempt proves the value was accepted: 200 *and* streaming began. */
function isAccepted(attempt) {
	return attempt.status === 200 && attempt.streamed;
}
/** A value no real model could accept, used to test whether the upstream checks. */
function sentinelValue(randomHex) {
	return `probe_sentinel_${randomHex()}`;
}
/**
* Run one sweep.
*
* The order is the protocol, not an optimization: skipping the sentinel because a
* level "looked fine" is precisely how a non-validating upstream ends up
* advertising five levels it ignores.
*/
async function runProbeSweep(send, options = {}) {
	const levels = options.levels ?? PROBE_LEVELS;
	const stopped = options.isStopped ?? (() => false);
	if (!isAccepted(await send(void 0))) return {
		validation: "unknown",
		efforts: []
	};
	const sentinel = await send(sentinelValue(() => randomHex()));
	if (stopped()) return {
		validation: "unknown",
		efforts: []
	};
	if (isAccepted(sentinel)) return {
		validation: "non-validating",
		efforts: []
	};
	if (!isRefusal(sentinel)) return {
		validation: "unknown",
		efforts: []
	};
	const efforts = [];
	for (const level of levels) {
		const attempt = await send(level);
		if (stopped()) return {
			validation: "unknown",
			efforts: []
		};
		if (isAccepted(attempt)) {
			efforts.push(level);
			continue;
		}
		if (!isRefusal(attempt)) return {
			validation: "unknown",
			efforts: []
		};
	}
	return {
		validation: "validating",
		efforts
	};
}
/** 24 hex chars of randomness, so a sentinel can never collide with a real value. */
function randomHex() {
	return randomBytes(12).toString("hex");
}
//#endregion
//#region src/probe-service.ts
/** Orchestrates sweeps and holds their in-flight state. */
var RaccoonProbeService = class {
	options;
	/** Tail of the queue; every sweep is chained onto it. */
	tail = Promise.resolve();
	/** The sweep currently running, if any. */
	current;
	runningCount = 0;
	constructor(options) {
		this.options = options;
	}
	/** Whether a sweep is in flight right now. */
	isRunning() {
		return this.runningCount > 0;
	}
	/**
	* Models the user could probe: every listed model without a decisive recorded
	* observation.
	*
	* The catalog's `reasoning` tag is tempting as a filter and is not one: it
	* labels the desktop app's routing presets, not the gateway's parameter
	* handling. Measured against the live catalog, `sn-glm-5-3-flash` carries no
	* `reasoning` tag and still streams `reasoning_content`, so narrowing by the
	* tag would hide a model the user may well want an effort control for. The
	* probe is the only evidence about `reasoning_effort` itself, so the only
	* exclusion here is "already answered".
	*/
	async candidates() {
		const account = (await this.options.store.current())?.accountId;
		if (account === void 0) return [];
		const out = [];
		for (const model of this.options.catalog.current()) {
			const record = this.options.probeStore.get(account, model.id, probeFingerprint(model));
			if (record !== void 0 && record.validation !== "unknown") continue;
			out.push({
				id: model.id,
				label: model.label === "" ? model.id : model.label
			});
		}
		return out;
	}
	/** Recorded observations for the current account, newest first. */
	async results() {
		const account = (await this.options.store.current())?.accountId;
		if (account === void 0) return [];
		const catalog = this.options.catalog.current();
		return this.options.probeStore.list(account).map(({ model, record }) => {
			return {
				id: model,
				name: catalog.find((entry) => entry.id === model)?.label ?? model,
				validation: record.validation,
				efforts: record.efforts,
				probedAt: record.probedAtMs
			};
		});
	}
	/**
	* Probe one model, queued behind any sweep already running.
	*
	* `manual` is the button press. Automatic callers pass false and are refused
	* unless the user granted standing consent, which is what keeps a catalog
	* refresh or a status poll from silently spending credit.
	*/
	async probe(modelId, manual) {
		if (!manual && !this.options.consent()) return {
			ok: false,
			reason: "no-consent"
		};
		const credential = await this.options.store.current();
		if (credential === void 0) return {
			ok: false,
			reason: "not-signed-in"
		};
		const model = this.options.catalog.current().find((entry) => entry.id === modelId);
		if (model === void 0) return {
			ok: false,
			reason: "not-candidate"
		};
		const account = credential.accountId;
		const fingerprint = probeFingerprint(model);
		const send = this.makeSender(modelId);
		const sweep = async () => {
			this.runningCount += 1;
			try {
				const outcome = await runProbeSweep(send);
				if ((await this.options.store.current())?.accountId !== account) return;
				this.options.probeStore.set(modelId, {
					fingerprint,
					validation: outcome.validation,
					efforts: outcome.efforts,
					probedAtMs: (this.options.now ?? Date.now)(),
					pluginVersion: this.options.pluginVersion,
					account
				});
				this.options.notify();
			} finally {
				this.runningCount -= 1;
				this.current = void 0;
			}
		};
		const chained = this.tail.then(sweep, sweep);
		this.tail = chained.catch(() => {});
		this.current = chained;
		await this.tail;
		return { ok: true };
	}
	/** Forget every recorded observation. */
	async clear() {
		this.options.probeStore.clear();
		this.options.notify();
	}
	/** Bind one model id to a send function that always uses a fresh token. */
	makeSender(modelId) {
		return async (effort) => {
			const credential = await this.options.store.resolve();
			return await this.options.upstream.probeEffort(credential.accessToken, modelId, { ...effort === void 0 ? {} : { effort } });
		};
	}
};
//#endregion
//#region src/net-guard.ts
/**
* Loopback request guards shared by the shim and the plugin's HTTP routes.
*
* Duplicated security code drifts, and this is code whose only job is to say
* "no" to the wrong caller, so both servers ask this module the same questions.
*/
/**
* Whether a `Host` header value names this machine.
*
* Bracketed IPv6 needs its own unwrapping step *before* the port is removed:
* `::1` has colons of its own, and naively taking everything before the first
* colon yields the empty string, which would reject the one IPv6 spelling a
* loopback client actually sends.
*/
function isLoopbackHost(value) {
	const host = hostnameOf(value);
	return host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1" || host.startsWith("127.");
}
/** Strip brackets and the port, leaving the address a client meant to reach. */
function hostnameOf(value) {
	const raw = value?.trim().toLowerCase() ?? "";
	if (raw === "") return "";
	if (raw.startsWith("[")) {
		const end = raw.indexOf("]");
		return end === -1 ? raw : raw.slice(1, end);
	}
	const parts = raw.split(":");
	return parts.length === 2 && /^\d+$/u.test(parts[1]) ? parts[0] : raw;
}
/**
* Whether an `Origin` header is acceptable.
*
* An absent Origin is a non-browser client (another local process, curl), which
* the `Host` check already covers; a present one must name a loopback host.
*/
function isLoopbackOrigin(value) {
	if (value === void 0 || value === "") return true;
	try {
		return isLoopbackHost(new URL(value).hostname);
	} catch {
		return false;
	}
}
/** The bearer token a request presented, or the empty string. */
function bearerOf(header) {
	return header?.startsWith("Bearer ") === true ? header.slice(7) : "";
}
/**
* Length-hiding string comparison.
*
* Both callers compare a secret, so the comparison must not leak how much of it
* matched; a length mismatch still costs one full comparison to keep timing
* uniform.
*/
function constantTimeEquals(presented, expected) {
	const actual = Buffer.from(presented);
	const secret = Buffer.from(expected);
	if (actual.length !== secret.length) {
		timingSafeEqual(secret, secret);
		return false;
	}
	return timingSafeEqual(actual, secret);
}
//#endregion
//#region src/routes.ts
/**
* The plugin's two same-origin HTTP routes.
*
* Both are mounted on the harness web server through `ctx.inject(['webServer'])`,
* which keeps them harmless in a Desktop or TUI composition where no server
* exists. Each is guarded the same way:
*
* - **Loopback Host and Origin.** The status route is readable by any process on
*   this machine already (it is a local port), but a page on another origin
*   reaching it through DNS rebinding should not learn which account is signed
*   in or what its token expiry is.
* - **In-process key, writes only.** The Origin guard defends against a foreign
*   *page*; it does not authorize an *action*. So the probe route additionally
*   requires `X-Raccoon-Probe-Key`, which is random per process and delivered
*   only inside the status document the card already had to fetch.
* - **Small bodies.** The probe route takes one tiny JSON action; anything
*   larger is a bug or an attack, and 4 KiB is generous for both.
*
* Secrets are never rendered here: the status document carries no token, and the
* probe key never reaches the logs.
*/
/** Largest probe-request body. */
const MAX_PROBE_BODY = 4096;
/** A key authorizing probe writes for this process. */
function createProbeKey() {
	return randomBytes(24).toString("hex");
}
function json(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}
function readBody(req, limit) {
	return new Promise((resolveBody, rejectBody) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				rejectBody(/* @__PURE__ */ new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
		req.on("error", rejectBody);
	});
}
/**
* Mount both routes and return a disposer removing them.
*
* Registration order does not matter to the server, but the two paths must be
* distinct — a duplicate (kind, path) throws by design, which is the right
* outcome for a misconfigured bundle.
*/
function registerRaccoonRoutes(web, options) {
	const statusDispose = web.register({
		kind: "exact",
		path: options.statusPath,
		handler: async (req, res) => {
			if (!isLoopbackHost(req.headers.host) || !isLoopbackOrigin(req.headers.origin)) {
				json(res, 403, {
					status: "error",
					message: "raccoon: loopback origin required"
				});
				return;
			}
			if (req.method !== "GET" && req.method !== "HEAD") {
				json(res, 405, {
					status: "error",
					message: "raccoon: status is read-only"
				});
				return;
			}
			try {
				json(res, 200, await options.buildStatus());
			} catch (error) {
				json(res, 500, {
					status: "error",
					message: error instanceof Error ? error.message : String(error)
				});
			}
		}
	});
	const probeDispose = web.register({
		kind: "exact",
		path: options.probePath,
		handler: async (req, res) => {
			if (!isLoopbackHost(req.headers.host) || !isLoopbackOrigin(req.headers.origin)) {
				json(res, 403, { error: "raccoon: loopback origin required" });
				return;
			}
			if (req.method !== "POST") {
				json(res, 405, { error: "raccoon: probe actions are POST-only" });
				return;
			}
			if (!constantTimeEquals(req.headers["X-Raccoon-Probe-Key".toLowerCase()] ?? "", options.probeKey)) {
				json(res, 401, { error: "raccoon: probe key missing or wrong" });
				return;
			}
			let action;
			try {
				const body = await readBody(req, MAX_PROBE_BODY);
				const parsed = JSON.parse(body);
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("expected an object");
				const fields = parsed;
				const requested = fields["action"];
				if (requested !== "probe" && requested !== "clear" && requested !== "refresh") throw new Error("action must be probe, clear, or refresh");
				const model = typeof fields["model"] === "string" ? fields["model"] : void 0;
				action = {
					action: requested,
					...model === void 0 ? {} : { model }
				};
			} catch (error) {
				json(res, 400, { error: `raccoon: ${error instanceof Error ? error.message : String(error)}` });
				return;
			}
			try {
				json(res, 200, await options.handleAction(action) ?? { ok: true });
			} catch (error) {
				json(res, 500, { error: error instanceof Error ? error.message : String(error) });
			}
		}
	});
	return () => {
		statusDispose();
		probeDispose();
	};
}
//#endregion
//#region src/shim.ts
/**
* Loopback OpenAI-compatible façade in front of the 小浣熊 gateway.
*
* pi-ai and the harness streaming pipeline are kept entirely unmodified: they
* talk OpenAI-compatible HTTP to a server bound to 127.0.0.1 on a random port,
* and everything that is *not* OpenAI-compatible about the upstream — resolving
* and refreshing the desktop credential, the identity headers, the error
* taxonomy — happens between this façade and the gateway. Two consequences are
* load-bearing:
*
* - the real access token never crosses into pi-ai. What pi-ai sends as its
*   `Authorization` value is this process's random shared secret, which the shim
*   checks in constant time before it will forward anything.
* - the upstream SSE body is piped through byte for byte, so usage accounting,
*   tool-call assembly and reasoning deltas are parsed by the same code the
*   harness uses for every other provider.
*
* @module dsh-raccoon-connect/shim
*/
/** Largest request body the shim will buffer. */
const MAX_BODY_BYTES = 67108864;
function writeJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}
/** An OpenAI-shaped error document, so pi-ai classifies it the way we intend. */
function openAiError(kind, message) {
	return { error: {
		message,
		type: kind,
		code: kind
	} };
}
/**
* Start the shim.
*
* The server is created and bound here rather than lazily: `baseUrl()` is read
* while the provider is being registered, and a port that only exists after the
* first request cannot be advertised to pi-ai.
*/
async function startRaccoonShim(options) {
	const secret = randomBytes(24).toString("hex");
	const server = createServer((req, res) => {
		handle(req, res).catch((error) => {
			writeJson(res, 500, openAiError("server", error instanceof Error ? error.message : String(error)));
		});
	});
	async function handle(req, res) {
		const path = (req.url ?? "").split("?")[0] ?? "";
		if (!isLoopbackHost(req.headers.host)) {
			writeJson(res, 403, openAiError("client", "raccoon shim: non-loopback Host rejected"));
			return;
		}
		if (!isLoopbackOrigin(req.headers.origin)) {
			writeJson(res, 403, openAiError("client", "raccoon shim: foreign Origin rejected"));
			return;
		}
		if (path === "/healthz") {
			writeJson(res, 200, { ok: true });
			return;
		}
		if (!constantTimeEquals(bearerOf(req.headers.authorization), secret)) {
			writeJson(res, 401, openAiError("client", "raccoon shim: shared secret missing or wrong"));
			return;
		}
		if (path === "/v1/models" && req.method === "GET") {
			writeJson(res, 200, shim.models());
			return;
		}
		if (path !== "/v1/chat/completions" || req.method !== "POST") {
			writeJson(res, 404, openAiError("not_found", `raccoon shim: no route for ${req.method} ${path}`));
			return;
		}
		if (!(req.headers["content-type"] ?? "").includes("application/json")) {
			writeJson(res, 415, openAiError("client", "raccoon shim: expected an JSON request body"));
			return;
		}
		let raw;
		try {
			raw = JSON.parse(await readBody(req));
		} catch {
			writeJson(res, 400, openAiError("client", "raccoon shim: request body is not JSON"));
			return;
		}
		let accessToken;
		try {
			accessToken = await options.accessToken();
		} catch (error) {
			writeJson(res, KIND_STATUS.session_dead, openAiError("session_dead", error instanceof Error ? error.message : String(error)));
			return;
		}
		const outcome = await options.upstream.chatStream(accessToken, raw, reqForSignal(req));
		if (outcome.ok === false) {
			const failure = outcome;
			writeJson(res, KIND_STATUS[failure.kind], openAiError(failure.kind, failure.message));
			return;
		}
		const stream = outcome;
		res.writeHead(stream.status, {
			"content-type": stream.contentType,
			"cache-control": "no-cache",
			connection: "keep-alive",
			"X-Accel-Buffering": "no"
		});
		await pipeThrough(stream, res);
	}
	function readBody(req) {
		return new Promise((resolveBody, rejectBody) => {
			const chunks = [];
			let size = 0;
			req.on("data", (chunk) => {
				size += chunk.length;
				if (size > MAX_BODY_BYTES) {
					rejectBody(/* @__PURE__ */ new Error("request body too large"));
					req.destroy();
					return;
				}
				chunks.push(chunk);
			});
			req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
			req.on("error", rejectBody);
		});
	}
	/**
	* Copy the upstream SSE body to the response.
	*
	* A mid-flight upstream failure still has to terminate the stream, or the
	* caller waits for an end that already happened; `[DONE]` is the terminator an
	* OpenAI client understands.
	*/
	async function pipeThrough(stream, res) {
		let sawDone = false;
		try {
			const source = Readable.fromWeb(stream.body);
			source.on("data", (chunk) => {
				if (chunk.includes("[DONE]")) sawDone = true;
			});
			await new Promise((resolvePipe, rejectPipe) => {
				source.once("error", rejectPipe);
				res.once("close", () => {
					source.destroy();
					resolvePipe();
				});
				source.pipe(res);
			});
		} catch {}
		if (!res.writableEnded) {
			if (!sawDone) res.end("data: [DONE]\n\n");
			else res.end();
		}
	}
	await new Promise((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen({
			host: "127.0.0.1",
			port: 0,
			exclusive: true
		}, () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("raccoon shim: failed to bind a loopback port");
	const port = address.port;
	const shim = {
		baseUrl: () => `http://127.0.0.1:${port}`,
		token: () => secret,
		port: () => port,
		models: () => ({
			object: "list",
			data: (options.catalog?.().current() ?? []).map((model) => ({
				id: model.id,
				object: "model"
			}))
		}),
		stop: () => new Promise((resolveStop) => {
			server.close(() => resolveStop());
			server.closeIdleConnections?.();
		})
	};
	return shim;
}
/** Abort signal tied to the client hanging up, so upstream spend stops with it. */
function reqForSignal(req) {
	if (typeof AbortSignal !== "undefined" && "abort" in AbortSignal) {
		const controller = new AbortController();
		req.once("aborted", () => controller.abort(/* @__PURE__ */ new Error("client disconnected")));
		req.once("close", () => controller.abort(/* @__PURE__ */ new Error("client disconnected")));
		return controller.signal;
	}
}
//#endregion
//#region src/index.ts
/**
* `dsh-raccoon-connect` — the 商汤小浣熊 desktop app's models as a DSH provider.
*
* Lifecycle in one paragraph, because the ordering is the design:
*
* 1. Register the provider **unconditionally** at startup, with an empty or
*    built-in catalog. What varies is whether the model group is *visible*, not
*    whether the provider exists — an empty catalog is how DSH hides a group, so
*    a sign-in that happens after boot works without re-registering anything.
* 2. Poll the credential files (never the network) to follow the desktop app's
*    sign-in, sign-out, and account switch.
* 3. On an identity change, adopt it: bump the generation (which is what makes an
*    in-flight fetch from the previous account refuse to write back), serve that
*    account's saved catalog if it has one, else the built-in roster, then fetch.
* 4. Serve requests through a loopback shim so the real token never enters
*    pi-ai, and refresh it through the store's single flight.
*
* Everything the plugin persists lives under `$DSH_HOME`: its own credential
* copy, saved catalogs, probe records, the host heartbeat. No token is ever
* written into a catalog or probe file.
*/
/** Stable Cordis plugin name; matches the `id` this bundle's patch inserts. */
const name = "llm-raccoon";
/** The LLM registry must exist before a provider can register into it. */
const inject = ["llm"];
/**
* Settings namespace owning the card's section.
*
* The namespace is what makes the card *render*: the settings Plugins tab
* dispatches `settings.plugin.item` by `entryKey = ns` for each served namespace
* and skips a card whose key names no installed section. So one card needs one
* section, and the section's schema must be split the same way as the card.
*/
const RACCOON_SETTINGS_NS = "raccoon";
/**
* How often the credential files are re-checked, in milliseconds.
*
* A boot-only read cannot notice a sign-in that happens while DSH is running, so
* the group would stay hidden until restart. This poll touches at most two local
* files: no network, no probe. `DSH_RACCOON_POLL_MS` overrides it for tests and
* for watching a slow sign-in; the value is clamped so a typo cannot become a
* busy loop.
*/
const CREDENTIAL_POLL_MS = 3e4;
const MIN_POLL_MS = 100;
const MAX_POLL_MS = 864e5;
/** Resolve the sweep interval, honoring the override when it is usable. */
function credentialPollMs() {
	const raw = process.env["DSH_RACCOON_POLL_MS"];
	if (raw === void 0 || raw.trim() === "") return CREDENTIAL_POLL_MS;
	const override = Number(raw);
	if (!Number.isFinite(override) || override < MIN_POLL_MS) return CREDENTIAL_POLL_MS;
	return Math.min(override, MAX_POLL_MS);
}
/**
* How long to wait before retrying a catalog fetch that failed.
*
* A same-account token rotation carries no new model information, so the sweep
* does not re-fetch on every tick. A *failed* fetch must not be treated the same
* way: without a retry bound, one transient network blip at boot would leave the
* group on the built-in roster until the user happened to press refresh.
*/
const CATALOG_RETRY_SWEEPS = 10;
/** How long a fetched balance answer stays presentable before being re-read. */
const POINTS_TTL_MS = 6e4;
const AUTH_FILE_FIELD = z.string().description("商汤小浣熊 credential file (defaults to the app's own ~/.box-agent/config/auth.json)");
const PROBE_CONSENT_FIELD = z.boolean().default(false).description("Authorize reasoning-effort probes (each probe sends real requests that may consume credit)");
const VISION_MODEL_IDS_FIELD = z.array(z.string()).default([]).description("模型 id 白名单：无视目录标签，一律按支持识图提供图片输入");
const TEXT_ONLY_MODEL_IDS_FIELD = z.array(z.string()).default([]).description("模型 id 黑名单：一律按纯文本提供，优先级高于识图白名单");
const Config = z.object({
	authFile: AUTH_FILE_FIELD,
	probeConsent: PROBE_CONSENT_FIELD,
	visionModelIds: VISION_MODEL_IDS_FIELD,
	textOnlyModelIds: TEXT_ONLY_MODEL_IDS_FIELD
});
z.object({
	authFile: AUTH_FILE_FIELD,
	probeConsent: PROBE_CONSENT_FIELD,
	visionModelIds: VISION_MODEL_IDS_FIELD,
	textOnlyModelIds: TEXT_ONLY_MODEL_IDS_FIELD
});
/**
* The configuration as the catalog wants it.
*
* Ids are trimmed and blanks dropped: a hand-edited list with a stray empty entry
* or trailing spaces should describe the models the user named, nothing more — an
* empty id matching everything would be the one way this escape hatch could
* silently switch capability off for the whole roster.
*/
function visionOverridesOf(config) {
	const idsOf = (ids) => (ids ?? []).map((id) => id.trim()).filter((id) => id !== "");
	return {
		imageInput: idsOf(config.visionModelIds),
		textOnly: idsOf(config.textOnlyModelIds)
	};
}
/** Build the runtime pieces that need no port and no registration. */
function createRuntime(config, current) {
	const client = new RaccoonUpstreamClient({
		variant: RACCOON_PRIMARY,
		identity: resolveClientIdentity
	});
	const store = new RaccoonCredentialStore({
		variant: RACCOON_PRIMARY,
		refresh: (token) => client.refresh(token),
		...config.authFile === void 0 ? {} : { desktopPath: config.authFile }
	});
	const catalog = new RaccoonCatalog(() => /* @__PURE__ */ new Date(), () => visionOverridesOf(current()));
	const probeStore = new RaccoonProbeStore(join(resolveDshHome(), RACCOON_PRIMARY.probeFilename));
	const savedCatalogs = new RaccoonCatalogStore(join(resolveDshHome(), RACCOON_PRIMARY.catalogFilename));
	const runtime = {
		variant: RACCOON_PRIMARY,
		store,
		client,
		catalog,
		probeStore,
		savedCatalogs,
		probeService: void 0,
		source: "fallback",
		lastAttemptMs: 0,
		generation: 0,
		registered: false
	};
	runtime.probeService = new RaccoonProbeService({
		catalog,
		store,
		upstream: client,
		probeStore,
		consent: () => current().probeConsent === true,
		pluginVersion: RACCOON_CONNECT_VERSION,
		notify: () => {
			runtime.invalidate?.();
		}
	});
	return runtime;
}
/** Badge rows for the card, derived from the catalog as it stands right now. */
function badgeRows(catalog, now = /* @__PURE__ */ new Date()) {
	return catalog.current().map((model) => {
		const rate = multiplierLabel(model);
		return {
			id: model.id,
			name: model.label === "" ? model.id : model.label,
			...rate === void 0 ? {} : { credits: rate },
			...isRateUnknown(model) ? { rateUnknown: true } : {},
			...isFree(model) ? { free: true } : {},
			badges: activeBadges(model, now),
			...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
			...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
			vision: supportsVision(model)
		};
	});
}
/** Serve the roster compiled into the plugin. */
function useFallback(runtime) {
	runtime.catalog.set({ models: FALLBACK_CATALOG });
	runtime.source = "fallback";
	runtime.fetchedAtMs = void 0;
	runtime.error = void 0;
}
/**
* Point the runtime at an account identity, invalidating what the previous one
* left behind.
*
* One helper for all four transitions (sweep sign-in, sweep sign-out, manual
* refresh, and a refresh that finds the user has signed out), because each of
* them has to do the same six things and a path that forgets one leaks state
* across accounts.
*/
function adoptIdentity(runtime, account) {
	const changed = account !== runtime.account;
	runtime.generation += 1;
	runtime.inflight = void 0;
	if (changed) {
		runtime.points = void 0;
		runtime.pointsError = void 0;
		runtime.pointsAtMs = void 0;
		runtime.account = account;
	}
	if (account === void 0) {
		runtime.catalog.hide();
		useFallback(runtime);
		runtime.invalidate?.();
		return;
	}
	const saved = runtime.savedCatalogs.get(account);
	if (saved !== void 0) {
		runtime.catalog.set({
			...saved.defaultModelId === void 0 ? {} : { defaultModelId: saved.defaultModelId },
			models: saved.models
		});
		runtime.source = "saved";
		runtime.fetchedAtMs = saved.fetchedAtMs;
		runtime.error = void 0;
	} else useFallback(runtime);
	runtime.catalog.show();
	runtime.invalidate?.();
}
/**
* Readable text for anything a caller may throw.
*
* `RaccoonUpstreamClient.failure()` throws a plain `{ ok: false, status, kind,
* message }` record rather than an `Error`, so `String(error)` flattened every
* upstream failure to `[object Object]`. Prefer the record's own fields, and
* fall back to the generic stringification only when there is nothing to read.
*/
function errorMessage(error) {
	if (error instanceof Error) return error.message;
	if (typeof error === "object" && error !== null) {
		const record = error;
		const message = typeof record["message"] === "string" ? record["message"].trim() : "";
		const tag = [typeof record["kind"] === "string" ? record["kind"] : "", typeof record["status"] === "number" ? String(record["status"]) : ""].filter((part) => part !== "").join(" ");
		if (message !== "" && tag !== "") return `${tag}: ${message}`;
		if (message !== "") return message;
		if (tag !== "") return `raccoon: catalog fetch failed (${tag})`;
	}
	return String(error);
}
/**
* Fetch this account's catalog.
*
* - **One request at a time**: a second caller joins the in-flight fetch.
* - **Generation-checked write-back**: a superseded answer is dropped.
* - **`resolve()`, not `current()`**: only `resolve()` performs the single-flight
*   token renewal, so an expired token refreshes instead of failing the fetch.
*   That is also where the plugin writes a rotated refresh token back to the
*   desktop file, which is what keeps the app signed in.
*/
async function fetchCatalog(runtime, account) {
	const inflight = runtime.inflight;
	const generation = runtime.generation;
	if (inflight !== void 0 && inflight.identity === account && inflight.generation === generation) {
		await inflight.promise;
		return;
	}
	const promise = (async () => {
		runtime.lastAttemptMs = Date.now();
		try {
			const credential = await runtime.store.resolve();
			if ((await runtime.store.current())?.accountId !== account || runtime.generation !== generation) return;
			const document = await runtime.client.fetchCatalog(credential.accessToken);
			if ((await runtime.store.current())?.accountId !== account || runtime.generation !== generation) return;
			runtime.catalog.set(document);
			runtime.catalog.show();
			runtime.source = "live";
			runtime.fetchedAtMs = Date.now();
			runtime.error = void 0;
			runtime.savedCatalogs.set(account, {
				version: 1,
				source: "live",
				fetchedAtMs: runtime.fetchedAtMs,
				...document.defaultModelId === void 0 ? {} : { defaultModelId: document.defaultModelId },
				models: document.models
			});
			runtime.invalidate?.();
		} catch (error) {
			runtime.error = errorMessage(error);
			runtime.invalidate?.();
		}
	})();
	runtime.inflight = {
		identity: account,
		generation,
		promise
	};
	try {
		await promise;
	} finally {
		if (runtime.inflight?.promise === promise) runtime.inflight = void 0;
	}
}
/**
* One credential sweep: notice sign-in, sign-out, and account switches.
*
* Never refreshes anything itself (`current()`, not `resolve()`), so an idle
* plugin makes no upstream calls; the fetch path does the renewing.
*/
async function sweep(runtime) {
	const account = (await runtime.store.current())?.accountId;
	if (account === void 0) {
		if (runtime.account !== void 0 || runtime.catalog.visible) adoptIdentity(runtime, void 0);
		return;
	}
	if (account !== runtime.account) {
		adoptIdentity(runtime, account);
		await fetchCatalog(runtime, account);
		return;
	}
	if (runtime.source !== "live" && Date.now() - runtime.lastAttemptMs >= CATALOG_RETRY_SWEEPS * credentialPollMs()) await fetchCatalog(runtime, account);
}
/** Build the document the settings card renders. Never throws. */
async function buildStatus(runtime, probeKey, consent, now = Date.now()) {
	const summary = await runtime.store.status();
	if (summary.state === "signed-out") return {
		status: "signed-out",
		...summary.reason === void 0 ? {} : { reason: summary.reason }
	};
	if (runtime.pointsAtMs === void 0 || now - runtime.pointsAtMs > POINTS_TTL_MS) {
		try {
			const credential = await runtime.store.resolve();
			runtime.points = await runtime.client.fetchBalance(credential.accessToken);
			runtime.pointsError = void 0;
		} catch (error) {
			runtime.pointsError = error instanceof Error ? error.message : String(error);
		}
		runtime.pointsAtMs = now;
	}
	const catalog = {
		source: runtime.source,
		...runtime.fetchedAtMs === void 0 ? {} : { fetchedAt: runtime.fetchedAtMs },
		...runtime.error === void 0 ? {} : { error: runtime.error }
	};
	return {
		status: "signed-in",
		...summary.nickname === void 0 ? {} : { nickname: summary.nickname },
		...summary.identity === void 0 ? {} : { identity: summary.identity },
		...summary.orgName === void 0 ? {} : { orgName: summary.orgName },
		...summary.source === void 0 ? {} : { source: summary.source },
		...summary.expiresAtMs === void 0 || summary.expiresAtMs <= 0 ? {} : { expiresAt: summary.expiresAtMs },
		...summary.refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAt: summary.refreshExpiresAtMs },
		...runtime.points === void 0 ? {} : { points: runtime.points },
		...runtime.pointsError === void 0 ? {} : { pointsError: runtime.pointsError },
		catalog,
		models: badgeRows(runtime.catalog),
		probe: {
			consent,
			running: runtime.probeService.isRunning(),
			candidates: (await runtime.probeService.candidates()).map((candidate) => candidate.id),
			results: await runtime.probeService.results()
		},
		probeKey
	};
}
/**
* Register the provider and start its lifecycle.
*
* The adapter is constructed only once the shim holds a port, because pi-ai's
* model descriptors capture the shim's base URL at construction time.
* Registration is unconditional; catalog visibility is what gates the group.
*/
async function bootstrap(ctx, runtime) {
	const shim = await startRaccoonShim({
		accessToken: async () => (await runtime.store.resolve()).accessToken,
		upstream: runtime.client,
		catalog: () => runtime.catalog
	});
	runtime.shim = shim;
	const adapter = createRaccoonAdapter({
		providerId: RACCOON_PRIMARY.id,
		displayName: RACCOON_PRIMARY.displayName,
		shim,
		catalog: runtime.catalog,
		resolveAttachments: () => ctx.get("attachments"),
		observe: (modelId) => {
			const model = runtime.catalog.current().find((entry) => entry.id === modelId);
			const account = runtime.account;
			if (model === void 0 || account === void 0) return void 0;
			return runtime.probeStore.get(account, modelId, probeFingerprint(model));
		}
	});
	runtime.invalidate = () => {
		adapter.invalidate();
		ctx.emit("llm/adapters-updated");
	};
	let releaseAdapter;
	let releaseDirectory;
	try {
		releaseAdapter = ctx.llm.registerAdapter([RACCOON_PRIMARY.id], adapter.adapter);
		releaseDirectory = ctx.llm.registerConfigurableProviders([{
			provider: RACCOON_PRIMARY.id,
			displayName: RACCOON_PRIMARY.displayName,
			settingsNs: RACCOON_SETTINGS_NS,
			settingsPath: [],
			declared: false
		}]);
	} catch (error) {
		releaseAdapter?.();
		releaseDirectory?.();
		runtime.shim = void 0;
		await shim.stop();
		throw error;
	}
	runtime.registered = true;
	writeHostHeartbeat(RACCOON_CONNECT_VERSION);
	ctx.logger.info(`dsh-raccoon-connect: registered ${RACCOON_PRIMARY.displayName} on loopback port ${shim.port()}`);
	return () => {
		releaseAdapter?.();
		releaseDirectory?.();
		runtime.registered = false;
		runtime.invalidate = void 0;
		runtime.shim = void 0;
		clearHostHeartbeat();
		shim.stop();
	};
}
/**
* Plugin entry point.
*
* @param ctx - Cordis context owning this plugin's effects.
* @param config - the applied configuration, live-replaced by the settings section.
*/
function apply(ctx, config) {
	let current = () => config;
	const runtime = createRuntime(config, () => current());
	const probeKey = createProbeKey();
	const timers = [];
	let stopped = false;
	let disposeRegistration;
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.configure({ auto: true });
	});
	ctx.inject(["webServer"], (webCtx) => {
		const dispose = registerRaccoonRoutes(webCtx.webServer, {
			statusPath: RACCOON_PRIMARY.statusPath,
			probePath: RACCOON_PRIMARY.probePath,
			probeKey,
			buildStatus: () => buildStatus(runtime, probeKey, current().probeConsent === true),
			handleAction: async (action) => {
				if (action.action === "clear") {
					await runtime.probeService.clear();
					return { ok: true };
				}
				if (action.action === "refresh") {
					const credential = await runtime.store.current();
					adoptIdentity(runtime, credential?.accountId);
					if (credential !== void 0) await fetchCatalog(runtime, credential.accountId);
					return {
						ok: true,
						source: runtime.source
					};
				}
				const model = action.model;
				if (model === void 0 || model === "") return {
					ok: false,
					error: "model is required"
				};
				const result = await runtime.probeService.probe(model, true);
				return result.ok ? { ok: true } : {
					ok: false,
					error: `probe not run: ${result.reason}`
				};
			}
		});
		return () => dispose();
	});
	const start = async () => {
		try {
			disposeRegistration = await bootstrap(ctx, runtime);
		} catch (error) {
			ctx.logger.error("dsh-raccoon-connect: provider registration failed", error);
			return;
		}
		if (stopped) {
			disposeRegistration();
			return;
		}
		await sweep(runtime).catch((error) => ctx.logger.error("dsh-raccoon-connect: initial sweep failed", error));
		timers.push(setInterval(() => {
			sweep(runtime).catch((error) => ctx.logger.error("dsh-raccoon-connect: credential sweep failed", error));
		}, credentialPollMs()));
	};
	start();
	ctx.effect(() => () => {
		stopped = true;
		for (const timer of timers) clearInterval(timer);
		timers.length = 0;
		disposeRegistration?.();
		clearHostHeartbeat();
	});
}
//#endregion
export { ALL_VARIANTS, Config, FALLBACK_CATALOG, MEASURED_VISION, RACCOON_PRIMARY, RACCOON_PROBE_PATH, RACCOON_SETTINGS_NS, RACCOON_STATUS_PATH, RaccoonCatalog, RaccoonCredentialStore, RaccoonUpstreamClient, adoptIdentity, apply, badgeRows, buildStatus, classifyUpstreamError, createRaccoonAdapter, credentialPollMs, decodeJwtClaims, fetchCatalog, inject, name, parseDesktopAuth, parseModelCatalog, probeFingerprint, reasoningFields, resolveClientIdentity, resolveVision, startRaccoonShim, sweep, userDataCandidates, variantFor, visionOverridesOf };
