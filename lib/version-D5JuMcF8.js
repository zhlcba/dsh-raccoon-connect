import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
//#region \0rolldown/runtime.js
var __require = /* #__PURE__ */ (() => createRequire(import.meta.url))();
//#endregion
//#region src/auth.ts
/**
* 小浣熊 credential resolution.
*
* The primary source is the credential file the desktop app already maintains
* for its own local agent: `~/.box-agent/config/auth.json` (relocatable through
* `BOX_AGENT_CONFIG_DIR`). Unlike the WorkBuddy-style "read the desktop file,
* never write it" design, 小浣熊's refresh token is **single-use**: refreshing
* rotates both tokens server-side, so a client that refreshes without writing
* the pair back would log the desktop app out at its next refresh. This store
* therefore (a) prefers re-reading the desktop file over refreshing whenever it
* still holds a live token, and (b) when it does have to refresh, writes the
* rotated pair back into the desktop file in the app's own shape, keeping a
* one-time backup of what it replaced.
*
* A plugin-owned copy under `$DSH_HOME` still exists for the case where the
* desktop file is absent or read-only; the fresher of the two wins.
*
* @module dsh-raccoon-connect/auth
*/
/** The keys the desktop app itself writes, in its own order. */
const DESKTOP_TOKEN_KEYS = [
	"access_token",
	"refresh_token",
	"office_identity",
	"office_org_name",
	"office_org_role"
];
/** Current on-disk format of the plugin-owned copy; readers reject others. */
const OWN_FORMAT_VERSION = 1;
/** Whether a filesystem error reports an absent path. */
function isENOENT(error) {
	return error?.code === "ENOENT";
}
function optionalString(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
/**
* Candidate locations for the desktop credential file, in probe order.
*
* The app resolves its own directory as `BOX_AGENT_CONFIG_DIR` or
* `~/.box-agent/config`, so the plugin mirrors that rather than guessing at
* per-platform application-data roots. An explicit setting or the variant's env
* var short-circuits the list to that one path.
*/
function desktopAuthCandidatesFor(variant) {
	const fromEnv = process.env[variant.env]?.trim();
	if (fromEnv !== void 0 && fromEnv !== "") return [fromEnv];
	const configured = process.env[variant.configDirEnv]?.trim();
	const dir = configured !== void 0 && configured !== "" ? configured : join(homedir(), ...variant.configDirRel.split("/"));
	return [join(dir, variant.desktopFilename)];
}
/**
* Decode the JWT claims the credential files carry.
*
* The desktop document stores no expiry field of its own, so lifetime and
* identity come from the tokens themselves: `exp`, `name`, `sid`, `iss`.
* Signature verification is not the plugin's job — it forwards the token and the
* upstream decides. Malformed or non-JWT values yield an empty claim set, which
* callers treat as "expiry unknown" rather than "expired".
*/
function decodeJwtClaims(token) {
	const segment = token.split(".")[1];
	if (segment === void 0 || segment === "") return {};
	try {
		const padded = segment.replace(/-/gu, "+").replace(/_/gu, "/");
		const decoded = Buffer.from(padded, "base64").toString("utf8");
		const parsed = JSON.parse(decoded);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}
/** `exp` claim in epoch milliseconds, or 0 when absent/unparsable. */
function expiryFromClaims(claims) {
	const exp = claims["exp"];
	return typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1e3 : 0;
}
/**
* The account key a credential belongs to.
*
* `sid` changes at every login, so it cannot scope anything; `iss` plus the
* `name` claim is the stable pair the observed tokens provide. A credential with
* neither falls back to a hash of the access token so two different unknown
* accounts still cannot collide into one saved catalog.
*/
function accountKeyOf(claims, accessToken) {
	const iss = optionalString(claims["iss"]) ?? "";
	const name = optionalString(claims["name"]) ?? "";
	if (iss !== "" || name !== "") return `${iss}:${name}`;
	if (accessToken === "") return "";
	let hash = 0;
	for (let index = 0; index < accessToken.length; index += 1) hash = hash * 31 + accessToken.charCodeAt(index) | 0;
	return `token:${(hash >>> 0).toString(16)}`;
}
/** Build a credential from a parsed desktop/own document. */
function credentialFrom(fields, source) {
	if (fields.accessToken === "") return void 0;
	const access = decodeJwtClaims(fields.accessToken);
	const refreshExpiresAtMs = expiryFromClaims(fields.refreshToken === "" ? {} : decodeJwtClaims(fields.refreshToken));
	const nickname = optionalString(access["name"]);
	return {
		accessToken: fields.accessToken,
		refreshToken: fields.refreshToken,
		expiresAtMs: expiryFromClaims(access),
		...refreshExpiresAtMs > 0 ? { refreshExpiresAtMs } : {},
		accountId: accountKeyOf(access, fields.accessToken),
		...nickname === void 0 ? {} : { nickname },
		...fields.identity === void 0 ? {} : { identity: fields.identity },
		...fields.orgName === void 0 ? {} : { orgName: fields.orgName },
		...fields.orgRole === void 0 ? {} : { orgRole: fields.orgRole },
		source
	};
}
/**
* Parse the desktop app's credential document.
*
* Accepts the app's own key set and the two aliases its reader accepts for the
* access token (`token`, `auth_token`), so an older or alternate build's file
* still works. Returns undefined when the document carries no access token.
*/
function parseDesktopAuth(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const document = parsed;
	const accessToken = optionalString(document["access_token"]) ?? optionalString(document["token"]) ?? optionalString(document["auth_token"]) ?? "";
	const identity = optionalString(document["office_identity"]);
	const orgName = optionalString(document["office_org_name"]);
	const orgRole = optionalString(document["office_org_role"]);
	return credentialFrom({
		accessToken,
		refreshToken: optionalString(document["refresh_token"]) ?? "",
		...identity === void 0 ? {} : { identity },
		...orgName === void 0 ? {} : { orgName },
		...orgRole === void 0 ? {} : { orgRole }
	}, "desktop");
}
/** Serialize the plugin-owned copy. */
function ownDocument(credential) {
	return {
		version: OWN_FORMAT_VERSION,
		credential
	};
}
/**
* Parse the plugin-owned copy; other versions and shapes are rejected.
*
* Deliberately a separate reader from {@link parseDesktopAuth}: the copy stores
* the normalized credential (camelCase, `expiresAtMs`, `accountId`), and
* round-tripping it through the desktop parser would lose the identity fields
* and recompute the expiry on every read.
*/
function parseOwnDocument(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const document = parsed;
	if (document["version"] !== OWN_FORMAT_VERSION) return void 0;
	if (typeof document["credential"] !== "object" || document["credential"] === null) return void 0;
	const stored = document["credential"];
	const accessToken = optionalString(stored["accessToken"]) ?? "";
	if (accessToken === "") return void 0;
	const expiresAtMs = typeof stored["expiresAtMs"] === "number" ? stored["expiresAtMs"] : 0;
	const refreshExpiresAtMs = typeof stored["refreshExpiresAtMs"] === "number" ? stored["refreshExpiresAtMs"] : void 0;
	const nickname = optionalString(stored["nickname"]);
	const identity = optionalString(stored["identity"]);
	const orgName = optionalString(stored["orgName"]);
	const orgRole = optionalString(stored["orgRole"]);
	const accountId = optionalString(stored["accountId"]) ?? accountKeyOf(decodeJwtClaims(accessToken), accessToken);
	return {
		accessToken,
		refreshToken: optionalString(stored["refreshToken"]) ?? "",
		expiresAtMs,
		...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
		accountId,
		...nickname === void 0 ? {} : { nickname },
		...identity === void 0 ? {} : { identity },
		...orgName === void 0 ? {} : { orgName },
		...orgRole === void 0 ? {} : { orgRole },
		source: "dsh"
	};
}
/**
* Credential store with demand-driven, write-back refresh.
*
* Refresh policy: re-read the desktop file on every resolution (the app does
* not cache it either), use a live access token as-is, and only refresh inside
* the margin. A failed refresh still returns a not-yet-expired token, so an
* unreachable refresh endpoint cannot take down a working session.
*/
var RaccoonCredentialStore = class {
	variant;
	refresh;
	refreshMarginMs;
	ownPath;
	fs;
	writeBackDesktop;
	desktopPathOverride;
	inflight;
	/** Desktop document last read, so a write-back can keep its other fields. */
	desktopDocument;
	/** Whether the pre-refresh backup of the desktop file has been taken. */
	backedUp = false;
	constructor(options) {
		this.variant = options.variant;
		this.refresh = options.refresh;
		this.refreshMarginMs = options.refreshMarginMs ?? 3e5;
		this.ownPath = options.ownPath ?? join(resolveDshHome(), options.variant.ownFilename);
		this.fs = options.fs;
		this.writeBackDesktop = options.writeBackDesktop ?? true;
		this.desktopPathOverride = options.desktopPath;
	}
	candidates() {
		if (this.desktopPathOverride !== void 0) return [this.desktopPathOverride];
		return desktopAuthCandidatesFor(this.variant);
	}
	/** The desktop credential path in effect, for diagnostics. */
	desktopAuthPath() {
		return this.candidates()[0] ?? "";
	}
	/** The plugin-owned copy path, for diagnostics. */
	ownAuthPath() {
		return this.ownPath;
	}
	/** Repoint the desktop file; a settings change applies on the next read. */
	setDesktopPath(path) {
		this.desktopPathOverride = path;
		this.desktopDocument = void 0;
	}
	/** Read the freshest stored credential without refreshing anything. */
	async current() {
		const [desktop, own] = await Promise.all([this.readDesktop(), this.readOwn()]);
		if (desktop === void 0) return own;
		if (own === void 0) return desktop;
		if (desktop.accountId !== own.accountId) return desktop;
		return own.expiresAtMs > desktop.expiresAtMs ? own : desktop;
	}
	/**
	* The credential to send upstream: {@link current}, refreshed on demand.
	* Single-flight, so parallel requests share one refresh — which matters more
	* here than in a read-only design, because two concurrent refreshes would burn
	* one single-use refresh token and strand the other caller.
	*/
	async resolve() {
		const credential = await this.current();
		if (credential === void 0) throw new Error(`raccoon: no signed-in ${this.variant.appName} account found; sign in once in the ${this.variant.appName} desktop app (expected ${this.desktopAuthPath()} or ${this.variant.env})`);
		if (!this.needsRefresh(credential)) return credential;
		this.inflight ??= this.refreshNow(credential).finally(() => {
			this.inflight = void 0;
		});
		return this.inflight;
	}
	/** Read-only sign-in summary; never refreshes and never throws. */
	async status() {
		try {
			const credential = await this.current();
			if (credential === void 0) return { state: "signed-out" };
			return {
				state: "signed-in",
				expiresAtMs: credential.expiresAtMs,
				...credential.refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
				...credential.nickname === void 0 ? {} : { nickname: credential.nickname },
				...credential.identity === void 0 ? {} : { identity: credential.identity },
				...credential.orgName === void 0 ? {} : { orgName: credential.orgName },
				source: credential.source
			};
		} catch (error) {
			return {
				state: "signed-out",
				reason: error instanceof Error ? error.message : String(error)
			};
		}
	}
	/**
	* Remove the plugin-owned copy and the desktop backup it wrote.
	*
	* The desktop credential file itself is never deleted: it belongs to the app,
	* and removing it would sign the user out of 小浣熊 as a side effect of a
	* plugin cleanup.
	*/
	async logout() {
		await this.remove(this.ownPath);
		await this.remove(`${this.ownPath}.lock`);
		await this.remove(this.backupPath());
	}
	backupPath() {
		return join(dirname(this.ownPath), `${this.variant.ownFilename}-desktop-backup`);
	}
	needsRefresh(credential) {
		if (credential.expiresAtMs <= 0) return false;
		return Date.now() + this.refreshMarginMs >= credential.expiresAtMs;
	}
	async refreshNow(credential) {
		if (credential.refreshToken === "") {
			if (credential.expiresAtMs > Date.now() + 3e4) return credential;
			throw new Error(`raccoon: access token expired and no refresh token is stored; sign in again in the ${this.variant.appName} desktop app`);
		}
		try {
			return await this.refreshOnce(credential);
		} catch (error) {
			if (this.isConflict(error)) {
				const reread = await this.readDesktop();
				if (reread !== void 0 && reread.accessToken !== credential.accessToken && !this.needsRefresh(reread)) return reread;
				if (reread !== void 0 && reread.refreshToken !== "" && reread.refreshToken !== credential.refreshToken) return await this.refreshOnce(reread);
			}
			if (credential.expiresAtMs > Date.now() + 3e4) return credential;
			throw new Error(`raccoon: token refresh failed and the access token is expired (${this.redact(error, credential)}); open the ${this.variant.appName} desktop app once to sign in again`);
		}
	}
	async refreshOnce(credential) {
		const outcome = await this.refresh(credential.refreshToken);
		const refreshed = credentialFrom({
			accessToken: outcome.accessToken,
			refreshToken: outcome.refreshToken ?? credential.refreshToken,
			...credential.identity === void 0 ? {} : { identity: credential.identity },
			...credential.orgName === void 0 ? {} : { orgName: credential.orgName },
			...credential.orgRole === void 0 ? {} : { orgRole: credential.orgRole }
		}, "dsh") ?? {
			...credential,
			accessToken: outcome.accessToken,
			source: "dsh"
		};
		await this.saveOwn(refreshed);
		if (this.writeBackDesktop) await this.saveDesktop(refreshed);
		return refreshed;
	}
	isConflict(error) {
		const message = error instanceof Error ? error.message : String(error);
		return message.includes("refresh_conflict") || message.includes("200822");
	}
	/** Error text with the presented credential stripped out. */
	redact(error, credential) {
		let message = error instanceof Error ? error.message : String(error);
		for (const secret of [credential.accessToken, credential.refreshToken]) if (secret !== "") message = message.split(secret).join("<redacted>");
		return message;
	}
	async saveOwn(credential) {
		await withFileLock(this.ownPath, async () => {
			await writeFileAtomic(this.ownPath, `${JSON.stringify(ownDocument(credential), null, 2)}\n`, {
				mode: 384,
				dirMode: 448
			});
		});
	}
	/**
	* Write the rotated pair back where the app reads it.
	*
	* The rewrite keeps the document's other fields and the app's own key order,
	* and mirrors its atomic temp-file-plus-rename write with mode 0600, so the
	* app cannot observe a half-written file. The first overwrite in a process
	* also leaves a backup of the replaced document next to the plugin's copy:
	* if a write-back ever strands the app's session, that file is the rollback.
	*/
	async saveDesktop(credential) {
		for (const path of this.candidates()) {
			const existing = this.desktopDocument ?? void 0;
			try {
				if (!this.backedUp) await this.backupDesktop(path);
				const document = { ...existing ?? {} };
				for (const key of DESKTOP_TOKEN_KEYS) delete document[key];
				document["access_token"] = credential.accessToken;
				document["refresh_token"] = credential.refreshToken;
				if (credential.identity !== void 0) document["office_identity"] = credential.identity;
				if (credential.orgName !== void 0) document["office_org_name"] = credential.orgName;
				if (credential.orgRole !== void 0) document["office_org_role"] = credential.orgRole;
				const payload = `${JSON.stringify(this.orderedDesktop(document), null, 2)}\n`;
				await this.writeAtomically(path, payload);
				this.desktopDocument = document;
				return;
			} catch {
				return;
			}
		}
	}
	/** The app's key order first, anything the user's file had afterwards. */
	orderedDesktop(document) {
		const ordered = {};
		for (const key of DESKTOP_TOKEN_KEYS) if (key in document) ordered[key] = document[key];
		for (const [key, value] of Object.entries(document)) if (!(key in ordered)) ordered[key] = value;
		return ordered;
	}
	async backupDesktop(path) {
		this.backedUp = true;
		try {
			const text = await this.read(path);
			if (text === void 0) return;
			await writeFileAtomic(this.backupPath(), text, {
				mode: 384,
				dirMode: 448
			});
		} catch {}
	}
	async writeAtomically(path, payload) {
		const temp = `${path}.${process.pid}.tmp`;
		try {
			await (this.fs?.writeFile ?? writeFile)(temp, payload, {
				encoding: "utf8",
				mode: 384
			});
			const { rename } = await import("node:fs/promises");
			await rename(temp, path);
		} catch (error) {
			await this.remove(temp);
			throw error;
		}
	}
	async remove(path) {
		try {
			await (this.fs?.rm ?? rm)(path, { force: true });
		} catch {}
	}
	async read(path) {
		try {
			return await (this.fs?.readFile ?? readFile)(path, "utf8");
		} catch (error) {
			if (isENOENT(error)) return void 0;
			throw error;
		}
	}
	/**
	* Read the first desktop candidate that exists.
	*
	* Only an absent file falls through to the next candidate; a file that is
	* present but unparsable is authoritative, so a broken file is never silently
	* skipped in favour of a stale older one. The parsed document is kept so a
	* later write-back can preserve the fields this plugin does not own.
	*/
	async readDesktop() {
		for (const path of this.candidates()) {
			const text = await this.read(path);
			if (text === void 0) continue;
			try {
				this.desktopDocument = JSON.parse(text);
			} catch {
				this.desktopDocument = void 0;
			}
			return parseDesktopAuth(text);
		}
		this.desktopDocument = void 0;
	}
	async readOwn() {
		try {
			const text = await this.read(this.ownPath);
			return text === void 0 ? void 0 : parseOwnDocument(text);
		} catch {
			return;
		}
	}
	/** Whether the desktop credential file exists as a regular file. */
	async desktopFilePresent() {
		for (const path of this.candidates()) try {
			if ((await (this.fs?.stat ?? stat)(path)).isFile()) return true;
		} catch {}
		return false;
	}
};
//#endregion
//#region src/catalog.ts
/**
* The 小浣熊 model catalog: upstream parsing, built-in fallback, per-account
* persistence, and the visible/hidden flag that decides whether the provider's
* model group appears at all.
*
* The upstream documents the catalog as `data.categories[].models[]` with a
* `chat` category, per-model `params.context_window` / `params.max_tokens`,
* `tags` for capabilities, and a `billing_*` family for price and promotion.
* Field shapes here come from reading the desktop app's own parser
* (`docs/upstream-protocol.md` §4), not from guessing, and every row is
* validated on the way in: an unusable row is dropped rather than served as a
* model that would fail the moment it is selected.
*
* @module dsh-raccoon-connect/catalog
*/
/**
* Image-input capability established by experiment rather than by the tag.
*
* The catalog's `vision` tag is the only capability field the upstream publishes
* — a raw row carries nothing else (`ability_level`, `params`, `billing_*` and
* `tags` are the whole vocabulary) — and on 2026-09-18 measurement found it wrong
* on two of the five visible rows, in *both* directions. So the tag is a prior,
* not a fact.
*
* The measurement is self-verifying and cheap: a generated PNG of three vertical
* stripes whose colors are drawn at random per run is sent with "name the colors
* left to right". A model that cannot see either says so or guesses; guessing the
* ordered triple correctly is a 1/120 shot, and the gateway that drops the image
* says so in the reply ("我无法看到或处理图片") rather than erroring — which is
* exactly why over-claiming is not caught by a status code here.
*
* Measured against `POST /chat/completions`, one decisive request per model:
*
* | model | `vision` tag | reads images |
* | --- | --- | --- |
* | `sn-sensenova-6-8-flash-lite` | yes | yes |
* | `sn-kimi-k3` | yes | yes (two independent runs) |
* | `sn-glm-5-3` | yes | **no** — image silently dropped |
* | `sn-glm-5-3-flash` | no | **yes** |
* | `sn-deepseek-v4-1-flash` | no | **yes** |
*
* Every visible row is listed on purpose: a stale tag should not be able to flip a
* model's capability back after the upstream edits its catalog, which is what
* would happen if only the disagreements were recorded.
*/
const MEASURED_VISION = {
	"sn-sensenova-6-8-flash-lite": true,
	"sn-kimi-k3": true,
	"sn-glm-5-3": false,
	"sn-glm-5-3-flash": true,
	"sn-deepseek-v4-1-flash": true
};
/**
* The image-input verdict for one row.
*
* `textOnly` outranks `imageInput` when an id appears in both: refusing an image
* costs the user one clearly-labelled rejection, while admitting one the gateway
* then discards produces a model that claims it cannot see — a worse failure, and
* one that arrives after the message is already durable. An id the upstream has
* never heard of keeps whatever the tag says; silence is not evidence of ability.
*/
function resolveVision(model, overrides = {}) {
	if (overrides.textOnly?.includes(model.id) === true) return false;
	if (overrides.imageInput?.includes(model.id) === true) return true;
	if (Object.hasOwn(MEASURED_VISION, model.id)) return MEASURED_VISION[model.id] === true;
	return model.tags.includes("vision");
}
/** Whether images may be sent to this model, per the verdict or the tag alone. */
function supportsVision(model) {
	return model.vision ?? model.tags.includes("vision");
}
function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function positiveInt(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : void 0;
}
function nonNegativeNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
function positiveNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
function trimmed(value) {
	return typeof value === "string" ? value.trim() : "";
}
/**
* Normalize capability tags.
*
* The upstream spells image support three ways across its own rows, and the
* desktop app folds the first two into `vision`; the plugin keeps that
* normalization so the image-input decision has exactly one thing to test.
* Non-string, over-long, and control-character-bearing entries are dropped and
* the list is capped, mirroring how the app's parser bounds hostile input.
*/
function normalizeTags(value) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const tag = entry.trim().toLowerCase();
		if (tag === "" || tag.length > 64 || /[\0-\x1f\x7f]/u.test(tag)) continue;
		const normalized = tag === "image" || tag === "image-understanding" ? "vision" : tag;
		if (!out.includes(normalized)) out.push(normalized);
		if (out.length >= 32) break;
	}
	return out;
}
function parseDiscounts(value) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const entry of value) {
		const row = asRecord(entry);
		if (row === void 0) continue;
		const name = trimmed(row["name"]);
		const multiplier = nonNegativeNumber(row["multiplier"]);
		if (name === "" || multiplier === void 0) continue;
		const dailyStart = trimmed(row["daily_start"]);
		const dailyEnd = trimmed(row["daily_end"]);
		const startAt = trimmed(row["start_at"]);
		const endAt = trimmed(row["end_at"]);
		out.push({
			name,
			multiplier,
			...dailyStart === "" ? {} : { dailyStart },
			...dailyEnd === "" ? {} : { dailyEnd },
			...startAt === "" ? {} : { startAt },
			...endAt === "" ? {} : { endAt },
			active: row["active"] === true
		});
	}
	return out;
}
/**
* Whether a promotion window covers `now`.
*
* `active` from the catalog is authoritative when present. Otherwise the daily
* and absolute windows are evaluated in the machine's local zone, which for the
* intended user is the same Asia/Shanghai zone the upstream bills in; a row that
* declares no window at all counts as live.
*/
function discountIsLive(discount, now) {
	if (discount.active) return true;
	const hasAbsolute = discount.startAt !== void 0 || discount.endAt !== void 0;
	const hasDaily = discount.dailyStart !== void 0 || discount.dailyEnd !== void 0;
	if (!hasAbsolute && !hasDaily) return true;
	if (hasAbsolute) {
		const from = discount.startAt === void 0 ? Number.NEGATIVE_INFINITY : Date.parse(discount.startAt);
		const to = discount.endAt === void 0 ? Number.POSITIVE_INFINITY : Date.parse(discount.endAt);
		if (Number.isNaN(from) || Number.isNaN(to)) return false;
		const at = now.getTime();
		if (at < from || at > to) return false;
	}
	if (hasDaily) {
		const minutes = now.getHours() * 60 + now.getMinutes();
		const from = minutesOf(discount.dailyStart, 0);
		const to = minutesOf(discount.dailyEnd, 1440);
		if (from === void 0 || to === void 0) return false;
		if (!(from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to)) return false;
	}
	return true;
}
function minutesOf(value, whenAbsent) {
	if (value === void 0) return whenAbsent;
	const match = /^(\d{1,2}):(\d{2})/u.exec(value);
	if (match === null) return void 0;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 23 || minutes > 59) return void 0;
	return hours * 60 + minutes;
}
/**
* Re-derive the time-boxed billing facts of one row.
*
* A catalog is fetched once and displayed for hours, so "currently discounted"
* cannot be baked in at parse time. Measured against the live gateway, a
* promotion's `multiplier` is a **factor on the list price**, not the resulting
* price: `sn-glm-5-3-flash` carries list 0.2 with a 0.5 factor and the upstream
* states 0.1 effective, while the free month carries list 0.5 with a 0 factor
* and states 0. So the live derivation is `list × cheapest live factor`, and
* once every window has closed the row returns to its list price — or, if it
* never had one, to no stateable price at all, because advertising a figure
* nobody is being charged is worse than admitting the price is unknown.
*/
function modelWithCurrentBilling(model, now) {
	if (model.billingDiscounts.length === 0) return model;
	const { billingEffectiveMultiplier: _stated, billingStatus: _statedStatus, billingDiscounts: _windows, ...rest } = model;
	const live = model.billingDiscounts.filter((discount) => discountIsLive(discount, now));
	if (live.length === 0) return {
		...rest,
		...model.billingMultiplier === void 0 ? {} : {
			billingEffectiveMultiplier: model.billingMultiplier,
			billingStatus: "normal"
		},
		billingDiscounts: []
	};
	if (model.billingMultiplier === void 0) return model;
	const best = live.reduce((acc, item) => item.multiplier < acc.multiplier ? item : acc);
	const effective = model.billingMultiplier * best.multiplier;
	return {
		...rest,
		billingEffectiveMultiplier: effective,
		billingStatus: effective === 0 ? "limited_free" : "discount",
		billingDiscounts: model.billingDiscounts
	};
}
/** Active promotion names, in upstream order. */
function activeBadges(model, now) {
	return model.billingDiscounts.filter((discount) => discountIsLive(discount, now)).map((discount) => discount.name);
}
/**
* The multiplier as display text, e.g. `x0.79`.
*
* Undefined when no price can be stated; the caller is then obliged to say the
* price is unknown rather than show a stale or invented figure.
*/
function multiplierLabel(model) {
	const value = model.billingEffectiveMultiplier ?? model.billingMultiplier;
	if (value === void 0) return void 0;
	return `x${value.toFixed(2)}`;
}
/** Whether the model is currently free. */
function isFree(model) {
	const value = model.billingEffectiveMultiplier ?? model.billingMultiplier;
	return value !== void 0 && value === 0;
}
/** Whether the row carries no stateable price (an expired promotion's leftover). */
function isRateUnknown(model) {
	return model.billingEffectiveMultiplier === void 0 && model.billingMultiplier === void 0 && model.billingDiscounts.length === 0 && model.billingStatusNote === void 0;
}
const MAX_TAGS = 32;
function parseModelRow(value) {
	const row = asRecord(value);
	if (row === void 0) return void 0;
	const id = trimmed(row["name"]);
	if (id === "") return void 0;
	const label = trimmed(row["description"]);
	const displayDescription = trimmed(row["display_description"]);
	const params = asRecord(row["params"]);
	const contextWindow = positiveInt(params?.["context_window"]) ?? positiveInt(row["context_window"]);
	const maxTokens = positiveInt(params?.["max_tokens"]) ?? positiveInt(row["max_tokens"]);
	const billingMultiplier = positiveNumber(row["billing_multiplier"]);
	const billingEffectiveMultiplier = nonNegativeNumber(row["billing_effective_multiplier"]);
	const rawStatus = trimmed(row["billing_status"]);
	const billingStatus = rawStatus === "normal" || rawStatus === "discount" || rawStatus === "limited_free" ? rawStatus : void 0;
	const note = trimmed(row["billing_status_note"]);
	return {
		id,
		label,
		...displayDescription === "" ? {} : { displayDescription },
		visible: row["visible"] !== false,
		tags: normalizeTags(row["tags"]).slice(0, MAX_TAGS),
		abilityLevel: positiveInt(row["ability_level"]) ?? 1,
		...contextWindow === void 0 ? {} : { contextWindow },
		...maxTokens === void 0 ? {} : { maxTokens },
		...billingMultiplier === void 0 ? {} : { billingMultiplier },
		...billingEffectiveMultiplier === void 0 ? {} : { billingEffectiveMultiplier },
		...billingStatus === void 0 ? {} : { billingStatus },
		...note === "" ? {} : { billingStatusNote: note },
		billingDiscounts: parseDiscounts(row["billing_discounts"])
	};
}
/**
* Parse a `model_catalog` response body.
*
* Accepts both the `{code, data}` envelope and a bare document, because the
* gateway has been observed to answer either way depending on the endpoint.
* Rows the plugin cannot call correctly (no window, or the desktop app's own
* internal agent routes) are dropped here rather than surfacing a model that
* errors on first use. Returns undefined when nothing usable survives, so the
* caller degrades to the saved or built-in catalog instead of publishing an
* empty group.
*/
function parseModelCatalog(document) {
	const root = asRecord(document);
	if (root === void 0) return void 0;
	if (root["code"] !== void 0 && root["code"] !== 0) return void 0;
	const payload = asRecord(root["data"]) ?? root;
	const chat = (Array.isArray(payload["categories"]) ? payload["categories"] : []).map(asRecord).filter((entry) => entry !== void 0).find((category) => trimmed(category["type"]) === "chat");
	if (chat === void 0) return void 0;
	const seen = /* @__PURE__ */ new Set();
	const models = [];
	for (const entry of Array.isArray(chat["models"]) ? chat["models"] : []) {
		const model = parseModelRow(entry);
		if (model === void 0 || seen.has(model.id)) continue;
		const labels = [model.id, model.label].map((value) => value.toLowerCase());
		if (!model.visible || labels.includes("raccoon-work")) continue;
		seen.add(model.id);
		models.push(model);
	}
	if (models.length === 0) return void 0;
	const declared = trimmed(chat["default_model"]);
	return {
		defaultModelId: models.some((model) => model.id === declared) ? declared : models[0].id,
		models
	};
}
/**
* The roster compiled into the plugin.
*
* Used only when the account has no saved catalog and the live one cannot be
* fetched (offline, gateway change, expired session). It is the catalog a real
* account actually received (`docs/upstream-protocol.md`), narrowed to what is
* stable: the windows and output ceilings we observed, and the capability tags
* the gateway itself put on each row. Prices are deliberately absent — an
* unknown price renders as 价格未知, which is honest, while a guessed multiplier
* is a number users would trust and act on. Only ids the gateway serves as chat
* models appear here: the app's internal agent binding (`raccoon-chat-ml-5-5`)
* is a routing default, not a selectable model, and listing it would offer a
* row that errors on first use.
*/
const FALLBACK_CATALOG = [
	{
		id: "sn-sensenova-6-8-flash-lite",
		label: "SenseNova-6.8-Flash-Lite",
		displayDescription: "内置兜底名册，价格以刷新后的目录为准",
		visible: true,
		tags: [
			"general",
			"chat",
			"rewrite",
			"summary",
			"fast",
			"vision"
		],
		abilityLevel: 1,
		contextWindow: 256e3,
		maxTokens: 63999,
		billingDiscounts: []
	},
	{
		id: "sn-glm-5-3",
		label: "GLM-5-3",
		displayDescription: "内置兜底名册，价格以刷新后的目录为准",
		visible: true,
		tags: [
			"general",
			"office",
			"code",
			"vision",
			"debug",
			"analysis",
			"html",
			"reasoning"
		],
		abilityLevel: 1,
		contextWindow: 1e6,
		maxTokens: 1e5,
		billingDiscounts: []
	},
	{
		id: "sn-kimi-k3",
		label: "Kimi-K3",
		displayDescription: "内置兜底名册，价格以刷新后的目录为准",
		visible: true,
		tags: [
			"general",
			"office",
			"code",
			"vision",
			"debug",
			"analysis",
			"html",
			"reasoning"
		],
		abilityLevel: 1,
		contextWindow: 1e6,
		maxTokens: 1e5,
		billingDiscounts: []
	},
	{
		id: "sn-glm-5-3-flash",
		label: "GLM-5-3-Flash",
		displayDescription: "内置兜底名册，价格以刷新后的目录为准",
		visible: true,
		tags: [
			"general",
			"chat",
			"rewrite",
			"summary",
			"fast"
		],
		abilityLevel: 1,
		contextWindow: 1e6,
		maxTokens: 1e5,
		billingDiscounts: []
	},
	{
		id: "sn-deepseek-v4-1-flash",
		label: "DeepSeek-V4.1-Flash",
		displayDescription: "内置兜底名册，价格以刷新后的目录为准",
		visible: true,
		tags: [
			"general",
			"code",
			"html",
			"analysis",
			"reasoning",
			"auto"
		],
		abilityLevel: 1,
		contextWindow: 1e6,
		maxTokens: 1e5,
		billingDiscounts: []
	}
].map((model) => ({ ...model }));
/**
* Per-account saved catalogs, one file per variant under `$DSH_HOME`.
*
* Keyed by account so switching users in the desktop app cannot serve one
* account's roster (with its prices and windows) to another. Writes are
* temp-file-plus-rename and failures are swallowed: a catalog cache is an
* optimization, never a reason for a request to fail.
*/
var RaccoonCatalogStore = class RaccoonCatalogStore {
	path;
	entries = /* @__PURE__ */ new Map();
	loaded = false;
	constructor(path = join(resolveDshHome(), ".raccoon-catalog.json")) {
		this.path = path;
	}
	/** Which account key is currently in use; scoping is explicit, not ambient. */
	static keyFor(accountId) {
		return accountId;
	}
	/**
	* Re-validate one row written by this store.
	*
	* Deliberately not {@link parseModelRow}: the file holds the *normalized*
	* shape (`id`/`label`/camelCase billing), and feeding that to the wire parser
	* would drop every row on the floor — `name` and `params` are simply not there
	* — which would silently collapse the documented live → saved → fallback
	* ladder into "always fallback after a restart".
	*/
	static reviveModel(value) {
		const row = asRecord(value);
		if (row === void 0) return void 0;
		const id = trimmed(row["id"]);
		if (id === "") return void 0;
		const label = trimmed(row["label"]);
		const description = trimmed(row["description"]);
		const displayDescription = trimmed(row["displayDescription"]);
		const billingMultiplier = positiveNumber(row["billingMultiplier"]);
		const billingEffectiveMultiplier = nonNegativeNumber(row["billingEffectiveMultiplier"]);
		const rawStatus = trimmed(row["billingStatus"]);
		const billingStatus = rawStatus === "normal" || rawStatus === "discount" || rawStatus === "limited_free" ? rawStatus : void 0;
		const note = trimmed(row["billingStatusNote"]);
		const contextWindow = positiveInt(row["contextWindow"]);
		const maxTokens = positiveInt(row["maxTokens"]);
		return {
			id,
			label,
			...description === "" ? {} : { description },
			...displayDescription === "" ? {} : { displayDescription },
			visible: row["visible"] !== false,
			tags: normalizeTags(row["tags"]).slice(0, MAX_TAGS),
			abilityLevel: positiveInt(row["abilityLevel"]) ?? 1,
			...contextWindow === void 0 ? {} : { contextWindow },
			...maxTokens === void 0 ? {} : { maxTokens },
			...billingMultiplier === void 0 ? {} : { billingMultiplier },
			...billingEffectiveMultiplier === void 0 ? {} : { billingEffectiveMultiplier },
			...billingStatus === void 0 ? {} : { billingStatus },
			...note === "" ? {} : { billingStatusNote: note },
			billingDiscounts: parseDiscounts(row["billingDiscounts"])
		};
	}
	load() {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const document = asRecord(JSON.parse(readFileSync(this.path, "utf8")));
			if (document?.["version"] !== 1) return;
			const entries = asRecord(document?.["entries"]);
			if (entries === void 0) return;
			for (const account of Object.keys(entries)) {
				const saved = asRecord(entries[account]);
				if (saved === void 0 || !Array.isArray(saved["models"])) continue;
				const models = saved["models"].map((entry) => RaccoonCatalogStore.reviveModel(entry)).filter((model) => model !== void 0);
				if (models.length === 0) continue;
				const source = trimmed(saved["source"]);
				const fetchedAtMs = typeof saved["fetchedAtMs"] === "number" ? saved["fetchedAtMs"] : 0;
				const defaultModelId = trimmed(saved["defaultModelId"]);
				this.entries.set(account, {
					version: 1,
					source: source === "live" || source === "saved" || source === "fallback" ? source : "live",
					fetchedAtMs,
					...defaultModelId === "" ? {} : { defaultModelId },
					models
				});
			}
		} catch {
			this.entries = /* @__PURE__ */ new Map();
		}
	}
	/** The last successful catalog for an account, if one is stored. */
	get(accountId) {
		this.load();
		return this.entries.get(RaccoonCatalogStore.keyFor(accountId));
	}
	/** Remember a catalog for an account. */
	set(accountId, catalog) {
		this.load();
		this.entries.set(RaccoonCatalogStore.keyFor(accountId), catalog);
		this.persist();
	}
	/** Forget an account (used when signing out). */
	remove(accountId) {
		this.load();
		if (this.entries.delete(RaccoonCatalogStore.keyFor(accountId))) this.persist();
	}
	persist() {
		try {
			mkdirSync(join(this.path, ".."), { recursive: true });
			const payload = `${JSON.stringify({
				version: 1,
				entries: Object.fromEntries(this.entries)
			}, null, 2)}\n`;
			const temp = `${this.path}.tmp`;
			writeFileSync(temp, payload, { mode: 384 });
			renameSync(temp, this.path);
		} catch {}
	}
};
/**
* The live model list one provider route serves.
*
* Separate from the data it holds: visibility is a lifecycle decision (sign out
* and the group disappears) while the rows are swapped independently, so the two
* are not conflated in one field the caller has to remember to keep in step.
*/
var RaccoonCatalog = class {
	now;
	visionOverrides;
	models = [];
	defaultModelId;
	shown = true;
	/**
	* @param now - clock used to re-derive time-boxed billing on every read.
	* @param visionOverrides - live view of the configured capability overrides.
	* Read per row, per call, so editing the configuration takes effect on the next
	* model-list render instead of only after the next catalog refresh.
	*/
	constructor(now = () => /* @__PURE__ */ new Date(), visionOverrides = () => ({})) {
		this.now = now;
		this.visionOverrides = visionOverrides;
	}
	/** Replace the rows. An empty list still respects the visibility flag. */
	set(document) {
		this.models = [...document.models];
		this.defaultModelId = document.defaultModelId;
	}
	/**
	* Current rows, with time-boxed billing re-derived and the image-input verdict
	* attached.
	*
	* The stored rows stay a faithful copy of what upstream said; `vision` is a
	* judgement made at read time from {@link MEASURED_VISION} plus the
	* configuration, so a plugin update that revises a verdict is never fighting a
	* verdict cached to disk.
	*/
	current() {
		if (!this.shown) return [];
		const now = this.now();
		const overrides = this.visionOverrides();
		return this.models.map((model) => {
			const billed = modelWithCurrentBilling(model, now);
			const vision = resolveVision(billed, overrides);
			return billed.vision === vision ? billed : {
				...billed,
				vision
			};
		});
	}
	/** One row by wire id, billing re-derived, or undefined. */
	find(id) {
		return this.current().find((entry) => entry.id === id);
	}
	/** Hide the group without dropping its rows (used while signed out). */
	hide() {
		this.shown = false;
	}
	/** Show a group whose rows have been restored. */
	show() {
		this.shown = true;
	}
	/** Whether the group is currently visible to the pickers. */
	get visible() {
		return this.shown;
	}
	/** The account's default model, when the catalog declared one. */
	get defaultModel() {
		return this.shown ? this.defaultModelId : void 0;
	}
	/** Forget everything; used when the account changes. */
	clear() {
		this.models = [];
		this.defaultModelId = void 0;
	}
};
//#endregion
//#region src/client-identity.ts
/**
* The desktop client's own identity, as the 小浣熊 gateway expects to see it.
*
* The web renderer derives `X-Client-Platform` / `X-Client-Version` /
* `X-Client-Device-ID` from its user-agent string; a headless plugin has no
* user agent, so it reads the same facts from where the app leaves them:
* `desktop-device-identity.json` in the app's Electron user-data directory, and
* the install tree for the version. Every field is optional — the gateway adds
* these headers when it has them and omits them otherwise, and a machine where
* the app has never run must still be able to use a credential file it was
* pointed at explicitly.
*
* @module dsh-raccoon-connect/client-identity
*/
/** Candidate user-data directories per platform, in probe order. */
function userDataCandidates() {
	const home = homedir();
	if (process.platform === "win32") {
		const appData = process.env["APPDATA"]?.trim();
		return [appData === void 0 || appData === "" ? join(home, "AppData", "Roaming") : appData].map((root) => join(root, "office-raccoon"));
	}
	if (process.platform === "darwin") return [join(home, "Library", "Application Support", "office-raccoon")];
	const xdg = process.env["XDG_CONFIG_HOME"]?.trim();
	return [join(xdg !== void 0 && xdg !== "" ? xdg : join(home, ".config"), "office-raccoon")];
}
/** The app's stable install id, or undefined when the app has never run here. */
function readDeviceId(userDataDir) {
	try {
		const parsed = JSON.parse(readFileSync(join(userDataDir, "desktop-device-identity.json"), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return void 0;
		const value = parsed["clientDeviceId"];
		return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
	} catch {
		return;
	}
}
/**
* Best-effort desktop version string.
*
* Windows keeps the Electron executable in a fixed install directory that is not
* recorded in any config file, so the plugin reads `version` off the update
* metadata the app itself maintains and gives up quietly otherwise — the header
* is optional, and a wrong version is worse than no version at all.
*/
function readInstalledVersion(userDataDir) {
	const candidates = [join(userDataDir, "update-install-attempt.json"), process.env["RACCOON_APP_DIR"] === void 0 ? "" : join(process.env["RACCOON_APP_DIR"], "resources", "app-update.yml")].filter((path) => path !== "");
	for (const path of candidates) try {
		const text = readFileSync(path, "utf8");
		const json = path.endsWith(".json") ? JSON.parse(text) : void 0;
		if (json !== void 0 && typeof json === "object" && json !== null) for (const key of [
			"version",
			"appVersion",
			"targetVersion"
		]) {
			const value = json[key];
			if (typeof value === "string" && /^\d+\.\d+\.\d+/u.test(value)) return value;
		}
		const match = /^version:\s*"?(\d+\.\d+\.\d+[^"\n]*)"?/mu.exec(text);
		if (match !== null) return match[1];
	} catch {}
}
/**
* Resolve the identity headers to send, reading disk at most once per process.
*
* Environment overrides win so a user on a non-standard install (portable app,
* different profile, WSL) can pin the values without code changes:
* `RACCOON_CLIENT_PLATFORM`, `RACCOON_CLIENT_VERSION`, `RACCOON_CLIENT_DEVICE_ID`.
*/
function resolveClientIdentity() {
	const platform = process.env["RACCOON_CLIENT_PLATFORM"]?.trim() || "desktop";
	const overrideVersion = process.env["RACCOON_CLIENT_VERSION"]?.trim();
	const overrideDevice = process.env["RACCOON_CLIENT_DEVICE_ID"]?.trim();
	const userDataDir = userDataCandidates().find((dir) => existsSync(dir));
	const resolved = {
		platform,
		...overrideVersion === void 0 || overrideVersion === "" ? {} : { version: overrideVersion },
		...overrideDevice === void 0 || overrideDevice === "" ? {} : { deviceId: overrideDevice },
		...userDataDir === void 0 ? {} : { userDataDir }
	};
	if (userDataDir === void 0) return resolved;
	const version = resolved.version ?? readInstalledVersion(userDataDir);
	const deviceId = resolved.deviceId ?? readDeviceId(userDataDir);
	return {
		...resolved,
		...version === void 0 ? {} : { version },
		...deviceId === void 0 ? {} : { deviceId }
	};
}
//#endregion
//#region src/heartbeat.ts
/**
* A one-file record that a DSH process currently has this plugin registered.
*
* The plugin's CLI runs in its own process, so it cannot ask the harness whether
* a provider is live. This heartbeat says so: the host writes it when a variant
* registers and removes it on disposal, and the CLI reads it to tell "the web
* session has this model group right now" apart from "a stale note left behind
* by a crash", which is the difference between telling the user to look at their
* open DSH window and telling them to start one.
*/
/** Where the heartbeat lives. */
function hostHeartbeatPath() {
	return join(resolveDshHome(), ".raccoon-host-heartbeat.json");
}
/** Record that this process registered the provider. Failures are silent. */
function writeHostHeartbeat(pluginVersion) {
	const record = {
		version: 1,
		package: "dsh-raccoon-connect",
		pluginVersion,
		registeredAt: Date.now(),
		pid: process.pid
	};
	try {
		writeFileSync(hostHeartbeatPath(), `${JSON.stringify(record, null, 2)}\n`, { mode: 384 });
	} catch {}
}
/** Remove this process's heartbeat. Safe when there is none. */
function clearHostHeartbeat() {
	try {
		rmSync(hostHeartbeatPath(), { force: true });
	} catch {}
}
/** Read the heartbeat, or undefined when absent or unreadable. */
function readHostHeartbeat() {
	try {
		const parsed = JSON.parse(readFileSync(hostHeartbeatPath(), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return void 0;
		const record = parsed;
		if (record["version"] !== 1) return void 0;
		if (typeof record["pid"] !== "number" || typeof record["registeredAt"] !== "number") return void 0;
		return {
			version: 1,
			package: typeof record["package"] === "string" ? record["package"] : "",
			pluginVersion: typeof record["pluginVersion"] === "string" ? record["pluginVersion"] : "",
			registeredAt: record["registeredAt"],
			pid: record["pid"]
		};
	} catch {
		return;
	}
}
/** Whether a process id is alive. */
function isProcessAlive(pid) {
	if (pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}
/**
* Liveness of the host that wrote the heartbeat.
*
* A bare PID check is wrong often enough to matter: process ids are recycled, so
* a host that died and left the file behind looks alive as soon as some unrelated
* process takes the number. When the recorded start time is obtainable, a host
* that began *after* its own registration note can only be a stranger. When it is
* not obtainable, liveness alone is reported — a conservative "probably running".
*/
function hostStatus() {
	const record = readHostHeartbeat();
	if (record === void 0) return "not-started";
	if (!isProcessAlive(record.pid)) return "stale";
	const startedAt = processStartTimeMs(record.pid);
	if (startedAt !== void 0 && startedAt > record.registeredAt) return "stale";
	return "running";
}
/**
* When a process began, in epoch milliseconds, when it can be determined.
*
* POSIX asks `ps`; Windows asks PowerShell, because `wmic` — what older tooling
* used — is gone from current builds. Both are best effort: an unparseable answer
* returns undefined rather than making the caller guess.
*/
function processStartTimeMs(pid) {
	try {
		const { execFileSync } = __require("node:child_process");
		if (process.platform === "win32") {
			const out = execFileSync("powershell.exe", [
				"-NoProfile",
				"-Command",
				`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`
			], {
				encoding: "utf8",
				timeout: 4e3,
				windowsHide: true
			});
			const at = Date.parse(String(out).trim());
			return Number.isNaN(at) ? void 0 : at;
		}
		const out = execFileSync("ps", [
			"-o",
			"lstart=",
			"-p",
			String(pid)
		], {
			encoding: "utf8",
			timeout: 4e3
		});
		const at = Date.parse(out.trim());
		return Number.isNaN(at) ? void 0 : at;
	} catch {
		return;
	}
}
/** What a fingerprint is computed from; keep this list short and deliberate. */
function probeFingerprint(model) {
	const material = JSON.stringify({
		id: model.id,
		vision: model.tags.includes("vision"),
		contextWindow: model.contextWindow ?? 0,
		maxTokens: model.maxTokens ?? 0
	});
	return createHash("sha256").update(material).digest("hex").slice(0, 16);
}
function isRecord(value) {
	if (typeof value !== "object" || value === null) return false;
	const record = value;
	return typeof record["fingerprint"] === "string" && typeof record["probedAtMs"] === "number" && typeof record["account"] === "string" && Array.isArray(record["efforts"]) && (record["validation"] === "validating" || record["validation"] === "non-validating" || record["validation"] === "unknown");
}
/**
* File-backed store, one file per variant.
*
* The file holds `{version, records: {modelId: record}}`. A corrupt or
* foreign-version file reads as empty rather than throwing: losing cached probe
* answers is a smaller failure than refusing to start. Writes go through a temp
* file and a rename, and a failure is swallowed for the same reason — the cache
* is an optimization.
*/
var RaccoonProbeStore = class {
	path;
	now;
	records = /* @__PURE__ */ new Map();
	loaded = false;
	constructor(path = join(resolveDshHome(), ".raccoon-probe.json"), now = () => Date.now()) {
		this.path = path;
		this.now = now;
	}
	load() {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8"));
			if (typeof parsed !== "object" || parsed === null) return;
			const document = parsed;
			if (document["version"] !== 1) return;
			const records = document["records"];
			if (typeof records !== "object" || records === null) return;
			for (const [model, value] of Object.entries(records)) if (isRecord(value)) this.records.set(model, value);
		} catch {
			this.records = /* @__PURE__ */ new Map();
		}
	}
	/** The live observation for one model, or undefined when none can be trusted. */
	get(account, model, fingerprint) {
		this.load();
		const record = this.records.get(model);
		if (record === void 0) return void 0;
		if (record.account !== account || record.fingerprint !== fingerprint) return void 0;
		if (this.now() - record.probedAtMs > 12096e5) return void 0;
		return record;
	}
	/**
	* Record one sweep's outcome for a model.
	*
	* Returns whether it was stored, so a caller can tell the user "nothing was
	* learned" without implying the write failed.
	*/
	set(model, record) {
		this.load();
		const previous = this.records.get(model);
		if (record.validation === "unknown" && previous !== void 0 && previous.validation !== "unknown") return false;
		this.records.set(model, record);
		this.persist();
		return true;
	}
	/** Newest-first view for display. */
	list(account) {
		this.load();
		return [...this.records.entries()].filter(([, record]) => account === void 0 || record.account === account).map(([model, record]) => ({
			model,
			record
		})).sort((a, b) => b.record.probedAtMs - a.record.probedAtMs);
	}
	/** Drop every observation, e.g. when the account changes. */
	clear() {
		this.load();
		if (this.records.size === 0) return;
		this.records = /* @__PURE__ */ new Map();
		this.persist();
	}
	persist() {
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			const payload = `${JSON.stringify({
				version: 1,
				records: Object.fromEntries(this.records)
			}, null, 2)}\n`;
			const temp = `${this.path}.tmp`;
			writeFileSync(temp, payload, { mode: 384 });
			renameSync(temp, this.path);
		} catch {}
	}
};
//#endregion
//#region src/upstream.ts
/**
* HTTP status the local shim re-exposes each kind as.
*
* The shim's caller is pi-ai's OpenAI client, which decides retry and error
* presentation from the status code, so kinds are mapped back onto the codes an
* OpenAI client already interprets correctly: 401/402/429 are terminal or
* retryable in exactly the ways the plugin wants them to be.
*/
const KIND_STATUS = {
	hard_credit: 402,
	soft_rate: 429,
	session_dead: 401,
	not_found: 502,
	server: 502,
	client: 400
};
/** Business codes meaning the session is gone and the app must sign in again. */
const SESSION_DEAD_CODES = /* @__PURE__ */ new Set(["200003", "200822"]);
/** Business codes and phrases meaning the account is out of credit. */
const CREDIT_CODES = /* @__PURE__ */ new Set([
	"200402",
	"200429",
	"100402"
]);
const CREDIT_PHRASES = [
	"积分不足",
	"余额不足",
	"点数不足",
	"quota exceeded",
	"insufficient balance",
	"insufficient points",
	"payment required"
];
/** Business codes and phrases meaning "rate limited, try later". */
const RATE_PHRASES = [
	"频繁",
	"too many requests",
	"rate limit"
];
function codeOf(parsed) {
	const code = parsed["code"];
	if (typeof code === "number" && Number.isFinite(code)) return String(code);
	if (typeof code === "string") return code;
	return "";
}
function messageOf(parsed) {
	for (const key of [
		"message",
		"msg",
		"error",
		"details"
	]) {
		const value = parsed[key];
		if (typeof value === "string" && value.trim() !== "") return value.trim();
	}
	return "";
}
/**
* Map an upstream failure onto a kind.
*
* Order matters: the gateway answers most failures with HTTP 400 plus a business
* code, so the code and message have to be read before the status decides.
*/
function classifyUpstreamError(status, body) {
	let code = "";
	let message = body;
	try {
		const parsed = JSON.parse(body);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			const document = parsed;
			code = codeOf(document);
			message = `${messageOf(document)} ${body}`;
		}
	} catch {}
	const lower = message.toLowerCase();
	if (SESSION_DEAD_CODES.has(code)) return "session_dead";
	if (CREDIT_CODES.has(code) || CREDIT_PHRASES.some((phrase) => lower.includes(phrase.toLowerCase()))) return "hard_credit";
	if (status === 429 || RATE_PHRASES.some((phrase) => lower.includes(phrase.toLowerCase()))) return "soft_rate";
	if (status === 401 || status === 403) return "session_dead";
	if (status === 404) return "not_found";
	if (status === 0 || status >= 500) return "server";
	return "client";
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* Read one SSE stream far enough to know whether it started.
*
* The probe must not wait for a full answer — that is what costs credit — so it
* resolves on the first `data:` line and aborts the request immediately after.
*/
async function readFirstEvent(body, signal) {
	const reader = body.getReader();
	const chunks = [];
	try {
		const read = await Promise.race([reader.read(), new Promise((resolveRead, rejectRead) => {
			const abort = () => rejectRead(/* @__PURE__ */ new Error("aborted"));
			if (signal?.aborted === true) abort();
			else signal?.addEventListener("abort", abort, { once: true });
		})]);
		if (read === null) return {
			streamed: false,
			body: ""
		};
		const text = new TextDecoder().decode(read.value ?? /* @__PURE__ */ new Uint8Array());
		chunks.push(text);
		return {
			streamed: /data:\s*(\[DONE\]|.{1,})/u.test(chunks.join("")),
			body: chunks.join("").slice(0, 4096)
		};
	} catch {
		return {
			streamed: false,
			body: chunks.join("").slice(0, 4096)
		};
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
/** The 小浣熊 gateway client. */
var RaccoonUpstreamClient = class RaccoonUpstreamClient {
	variant;
	identity;
	fetchImpl;
	timeoutMs;
	constructor(options) {
		this.variant = options.variant;
		this.identity = options.identity ?? (() => ({ platform: "desktop" }));
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
		this.timeoutMs = options.timeoutMs ?? 2e4;
	}
	/** LLM gateway base, without a trailing slash. */
	get llmBase() {
		return this.variant.llmBase.replace(/\/+$/u, "");
	}
	get authBase() {
		return `${this.variant.siteOrigin.replace(/\/+$/u, "")}/api/web/auth/v1`;
	}
	get pointsBase() {
		return `${this.variant.siteOrigin.replace(/\/+$/u, "")}/api/web/points/v1`;
	}
	/**
	* Headers every authenticated call carries.
	*
	* The identity headers are omitted rather than sent empty: the web client
	* only adds them when it could parse its own user agent, and an empty
	* `X-Client-Device-ID` is a different statement from no header.
	*/
	headers(accessToken, identity = this.identity()) {
		const out = {
			"Content-Type": "application/json",
			Accept: "application/json",
			Authorization: `Bearer ${accessToken}`,
			"X-Org-Code": "",
			"X-Raccoon-Language": "zh",
			"X-Client-Platform": identity.platform
		};
		if (identity.version !== void 0) out["X-Client-Version"] = identity.version;
		if (identity.deviceId !== void 0) out["X-Client-Device-ID"] = identity.deviceId;
		return out;
	}
	/** POST with a timeout that never fires once streaming starts. */
	async request(url, init, timeoutMs) {
		if (timeoutMs <= 0) return await this.fetchImpl(url, init);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(/* @__PURE__ */ new Error("timeout")), timeoutMs);
		const caller = init.signal;
		const relay = () => controller.abort(caller?.reason ?? /* @__PURE__ */ new Error("aborted"));
		if (caller !== null && caller !== void 0) {
			if (caller.aborted) relay();
			else caller.addEventListener("abort", relay, { once: true });
		}
		try {
			return await this.fetchImpl(url, {
				...init,
				signal: controller.signal
			});
		} finally {
			clearTimeout(timer);
		}
	}
	static async textOf(response) {
		try {
			return (await response.text()).slice(0, 4096);
		} catch {
			return "";
		}
	}
	/**
	* Unwrap the `{code, message, data}` envelope.
	*
	* A non-zero code is a failure even on HTTP 200, and the message is kept
	* because its business phrase is how `classifyUpstreamError` recognizes credit
	* exhaustion. A body with no envelope at all is returned as-is, since that is
	* how the gateway answers some endpoints.
	*/
	static async envelope(response) {
		const text = await RaccoonUpstreamClient.textOf(response);
		if (!response.ok) return {
			ok: false,
			status: response.status,
			kind: classifyUpstreamError(response.status, text),
			message: text
		};
		try {
			const parsed = JSON.parse(text);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				const document = parsed;
				const code = codeOf(document);
				if (code !== "" && code !== "0") return {
					ok: false,
					status: response.status,
					kind: classifyUpstreamError(200, text),
					message: text
				};
				return {
					ok: true,
					data: "data" in document ? document["data"] : document
				};
			}
			return {
				ok: true,
				data: parsed
			};
		} catch {
			return {
				ok: false,
				status: response.status,
				kind: "client",
				message: text
			};
		}
	}
	static failure(response) {
		return response;
	}
	/**
	* Exchange a refresh token for a fresh pair.
	*
	* Deliberately unauthenticated: the refresh token is the credential, and the
	* gateway rejects a request that also carries an `Authorization` header.
	* The desktop app's failure text is reproduced here so a caller that sees the
	* error knows which leg broke.
	*/
	async refresh(refreshToken) {
		if (refreshToken === "") throw new Error("raccoon: no refresh token to exchange");
		let response;
		try {
			response = await this.request(`${this.authBase}/refresh`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json"
				},
				body: JSON.stringify({ refresh_token: refreshToken })
			}, this.timeoutMs);
		} catch (error) {
			throw new Error(`raccoon: refresh request failed (${errorMessage(error)})`);
		}
		const parsed = await RaccoonUpstreamClient.envelope(response);
		if (parsed.ok === false) throw new Error(`raccoon: refresh rejected ${parsed.kind} (HTTP ${parsed.status}): ${parsed.message.slice(0, 200)}`);
		const data = parsed.data;
		if (typeof data !== "object" || data === null) throw new Error("raccoon: refresh returned no data");
		const fields = data;
		const accessToken = typeof fields["access_token"] === "string" ? fields["access_token"] : "";
		if (accessToken === "") throw new Error("raccoon: refresh response carried no access_token");
		const nextRefresh = typeof fields["refresh_token"] === "string" && fields["refresh_token"] !== "" ? fields["refresh_token"] : void 0;
		return {
			accessToken,
			...nextRefresh === void 0 ? {} : { refreshToken: nextRefresh }
		};
	}
	/** Fetch and parse the model catalog. */
	async fetchCatalog(accessToken, signal) {
		const response = await this.request(`${this.llmBase}/model_catalog`, {
			method: "GET",
			headers: this.headers(accessToken),
			...signal === void 0 ? {} : { signal }
		}, this.timeoutMs);
		const parsed = await RaccoonUpstreamClient.envelope(response);
		if (parsed.ok === false) throw RaccoonUpstreamClient.failure(parsed);
		const fromParser = parseCatalogDocument(parsed.data);
		if (fromParser === void 0) throw new Error("raccoon: model_catalog resolved to an empty list");
		return fromParser;
	}
	/** Remaining credit and plan label, best effort. */
	async fetchBalance(accessToken, signal) {
		const response = await this.request(`${this.pointsBase}/balance`, {
			method: "GET",
			headers: this.headers(accessToken),
			...signal === void 0 ? {} : { signal }
		}, this.timeoutMs);
		const parsed = await RaccoonUpstreamClient.envelope(response);
		if (parsed.ok === false) throw RaccoonUpstreamClient.failure(parsed);
		const data = parsed.data;
		if (typeof data !== "object" || data === null) return {};
		const fields = data;
		const total = firstNumber(fields, [
			"total",
			"available",
			"available_points",
			"balance",
			"remain",
			"points",
			"remain_points"
		]);
		const plan = firstString(fields, [
			"plan",
			"plan_name",
			"package",
			"package_name",
			"type"
		]);
		const note = firstString(fields, [
			"note",
			"description",
			"message"
		]);
		return {
			...total === void 0 ? {} : { total },
			...plan === void 0 ? {} : { plan },
			...note === void 0 ? {} : { note }
		};
	}
	/**
	* Stream one chat completion.
	*
	* The body is passed through as the caller built it: this gateway is the same
	* OpenAI-compatible endpoint the desktop app's own agent uses, so rewriting
	* fields here would only risk diverging from what it actually accepts. The
	* response body is returned unread so the shim can pipe it byte for byte.
	*/
	async chatStream(accessToken, body, signal) {
		let response;
		try {
			response = await this.request(`${this.llmBase}/chat/completions`, {
				method: "POST",
				headers: this.headers(accessToken),
				body: JSON.stringify(body),
				...signal === void 0 ? {} : { signal }
			}, 0);
		} catch (error) {
			return {
				ok: false,
				status: 0,
				kind: "server",
				message: errorMessage(error)
			};
		}
		if (!response.ok || response.body === null) {
			const text = await RaccoonUpstreamClient.textOf(response);
			return {
				ok: false,
				status: response.status,
				kind: classifyUpstreamError(response.status === 0 ? 502 : response.status, text),
				message: response.body === null && response.ok ? "raccoon: upstream returned an empty body" : text
			};
		}
		return {
			ok: true,
			status: response.status,
			body: response.body,
			contentType: response.headers.get("content-type") ?? "text/event-stream"
		};
	}
	/**
	* Spend the smallest possible request to learn whether one parameter value is
	* honored.
	*
	* `max_tokens` is kept at the gateway's floor and the reader hangs up on the
	* first SSE event, because a probe that waits for a full answer is a paid
	* completion wearing a lab coat.
	*/
	async probeEffort(accessToken, model, options = {}) {
		const messages = [];
		if (options.systemPrefix !== void 0 && options.systemPrefix !== "") messages.push({
			role: "system",
			content: options.systemPrefix
		});
		messages.push({
			role: "user",
			content: "ping"
		});
		const payload = {
			model,
			stream: true,
			messages,
			max_tokens: options.maxTokens ?? 1
		};
		if (options.effort !== void 0) payload["reasoning_effort"] = options.effort;
		let response;
		try {
			response = await this.request(`${this.llmBase}/chat/completions`, {
				method: "POST",
				headers: this.headers(accessToken),
				body: JSON.stringify(payload),
				...options.signal === void 0 ? {} : { signal: options.signal }
			}, 0);
		} catch (error) {
			errorMessage(error);
			return {
				status: 0,
				accepted: false,
				streamed: false
			};
		}
		const text = response.ok && response.body !== null ? "" : await RaccoonUpstreamClient.textOf(response);
		if (!response.ok || response.body === null) {
			const code = probeErrorCodeOf(text);
			return {
				status: response.status,
				accepted: false,
				streamed: false,
				...code === void 0 ? {} : { errorCode: code },
				...text === "" ? {} : { message: text.slice(0, 512) }
			};
		}
		const first = await readFirstEvent(response.body, options.signal);
		const code = probeErrorCodeOf(first.body);
		return {
			status: response.status,
			accepted: first.streamed,
			streamed: first.streamed,
			...code === void 0 ? {} : { errorCode: code },
			...first.body === "" ? {} : { message: first.body.slice(0, 512) }
		};
	}
};
/** Parse a business code out of a rejected probe body. */
function probeErrorCodeOf(body) {
	if (body === "") return void 0;
	try {
		const parsed = JSON.parse(body);
		if (typeof parsed !== "object" || parsed === null) return void 0;
		const code = parsed["code"];
		if (typeof code === "number" && Number.isFinite(code)) return String(code);
		if (typeof code === "string" && code !== "") return code;
		return;
	} catch {
		return;
	}
}
function firstNumber(fields, keys) {
	for (const key of keys) {
		const value = fields[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
}
function firstString(fields, keys) {
	for (const key of keys) {
		const value = fields[key];
		if (typeof value === "string" && value.trim() !== "") return value.trim();
	}
}
/** Envelope data may already be the document, or its `data` member. */
function parseCatalogDocument(document) {
	return parseModelCatalog(document);
}
//#endregion
//#region src/status-paths.ts
/**
* Node-free constants and types shared by the host and browser halves.
*
* The host bundle and the browser bundle are built separately, so every route
* the card may ask for is a literal here rather than a computed suffix: a
* shared expression is one build-config drift away from the desk calling a
* route the host never mounted.
*
* @module dsh-raccoon-connect/status-paths
*/
/** Plugin-owned read-only status endpoint consumed by the settings card. */
const RACCOON_STATUS_PATH = "/plugins/dsh-raccoon-connect/status";
/**
* Plugin-owned probe control endpoint.
*
* Separate from the status route because it accepts writes: the status route's
* loopback Host/Origin guard defends against a DNS-rebinding *page*, which is
* not the same as authorizing a state-changing action. This route therefore
* also requires the in-process key the browser half receives with the status
* document.
*/
const RACCOON_PROBE_PATH = "/plugins/dsh-raccoon-connect/probe";
//#endregion
//#region src/variants.ts
/**
* The 小浣熊 product variants this plugin serves.
*
* Everything that can differ between two SenseTime desktop clients — gateway
* base, credential location, file names, display identity, routes — is one
* descriptor here, so no module carries its own `if (raccoon)` branch and
* adding a second product (e.g. 代码小浣熊) is a data change rather than a
* refactor. Today there is exactly one: 办公小浣熊 desktop.
*
* This module is host-side (it names files and env vars). The browser half
* takes the same routes from the Node-free `status-paths.ts`, which stays the
* single source shared by both halves.
*
* @module dsh-raccoon-connect/variants
*/
/**
* 办公小浣熊 desktop.
*
* Its credential file is the one the app already maintains for its own local
* agent (`box-agent`), which is what makes zero-configuration reuse possible:
* the app writes it on sign-in and on every token refresh, and the plugin only
* ever has to read — and, when it refreshes, write back in the same shape.
*/
const RACCOON_PRIMARY = {
	id: "raccoon",
	displayName: "商汤小浣熊",
	appName: "商汤小浣熊",
	llmBase: "https://xiaohuanxiong.com/api/web/llm/v2",
	siteOrigin: "https://xiaohuanxiong.com",
	env: "RACCOON_AUTH_FILE",
	configDirEnv: "BOX_AGENT_CONFIG_DIR",
	configDirRel: ".box-agent/config",
	desktopFilename: "auth.json",
	ownFilename: ".raccoon-auth.json",
	probeFilename: ".raccoon-probe.json",
	catalogFilename: ".raccoon-catalog.json",
	statusPath: RACCOON_STATUS_PATH,
	probePath: RACCOON_PROBE_PATH
};
/** Every variant the plugin registers. */
const ALL_VARIANTS = [RACCOON_PRIMARY];
/** Look up a variant by provider id. */
function variantFor(id) {
	return ALL_VARIANTS.find((variant) => variant.id === id);
}
//#endregion
//#region src/version.ts
const RACCOON_CONNECT_VERSION = "0.2.0";
//#endregion
export { RaccoonCredentialStore as A, activeBadges as C, parseModelCatalog as D, multiplierLabel as E, parseDesktopAuth as M, resolveVision as O, RaccoonCatalogStore as S, isRateUnknown as T, resolveClientIdentity as _, RACCOON_PROBE_PATH as a, MEASURED_VISION as b, RaccoonUpstreamClient as c, probeFingerprint as d, clearHostHeartbeat as f, writeHostHeartbeat as g, readHostHeartbeat as h, variantFor as i, decodeJwtClaims as j, supportsVision as k, classifyUpstreamError as l, hostStatus as m, ALL_VARIANTS as n, RACCOON_STATUS_PATH as o, hostHeartbeatPath as p, RACCOON_PRIMARY as r, KIND_STATUS as s, RACCOON_CONNECT_VERSION as t, RaccoonProbeStore as u, userDataCandidates as v, isFree as w, RaccoonCatalog as x, FALLBACK_CATALOG as y };
