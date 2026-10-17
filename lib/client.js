window.__ModuleLoader__.load({
	id: "dsh-raccoon-connect",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
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
		//#region src/client/status-document.ts
		/**
		* Whether a parsed status response really is a status document.
		*
		* A 200 is not a promise about the body: it may be empty, literal `null`, a
		* non-JSON page from a proxy, or an array. Both halves of the browser plugin
		* read the same route, so both must agree on what is valid — storing an
		* unreadable value puts something in state that the next render dereferences.
		*
		* The check is deliberately limited to the discriminator (plus `error`'s
		* `message`, which the error paragraph renders): validating optional fields
		* here would reject documents the host legitimately omits fields from.
		*/
		function isRaccoonWebStatus(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
			const wrapped = value;
			const status = wrapped["status"];
			if (status === "signed-out" || status === "signed-in") return true;
			return status === "error" && typeof wrapped["message"] === "string";
		}
		//#endregion
		//#region src/client/RaccoonPluginCard.tsx
		/**
		* 小浣熊 account status card contributed to DSH Plugin configuration.
		*
		* Renders every field the shared status document (`src/status-paths.ts`)
		* carries: sign-in state, identity, which credential file the session came
		* from, token expiries, catalog provenance, per-model context/rate/badges,
		* remaining credit, and the reasoning-effort probe section. The card is built
		* off a {@link RaccoonCardVariant} descriptor — id, display name, and the two
		* routes — so registering a second 小浣熊 product is a data change in
		* {@link CARD_VARIANTS}, not a component fork: the copy takes the product name
		* as a `{name}` parameter and the routes come from the descriptor.
		*
		* Three invariants this component exists to keep (each pinned by
		* `tests/plugin-card.spec.ts`):
		* - a failed read annotates the document already on screen, never blanks it;
		* - newest-read-wins: when reads overlap, only the one whose request started
		*   last may write state (a slow older response must not revert the card);
		* - the poll's liveness depends on the last *successful* read, so one
		*   transient error cannot disarm it, while a genuine signed-out answer stops it.
		*/
		/** 办公小浣熊 desktop, the plugin's only product today and its default card. */
		const RACCOON_CARD = {
			id: "raccoon",
			displayName: "商汤小浣熊",
			statusPath: RACCOON_STATUS_PATH,
			probePath: RACCOON_PROBE_PATH
		};
		/** Every card, in display order. A second variant joins this list, nothing else changes. */
		const CARD_VARIANTS = [RACCOON_CARD];
		const POLL_INTERVAL_MS = 6e4;
		const cardStyle = {
			overflow: "hidden",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 10,
			background: "var(--dsw-alias-bg-module-platform)"
		};
		const headerStyle = {
			boxSizing: "border-box",
			width: "100%",
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 16,
			border: 0,
			padding: "13px 14px",
			background: "transparent",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			textAlign: "left",
			cursor: "pointer"
		};
		const headTextStyle = {
			display: "flex",
			minWidth: 0,
			flexDirection: "column",
			gap: 3
		};
		const nameStyle = {
			fontSize: 14,
			lineHeight: "20px",
			fontWeight: 600
		};
		const descriptionStyle = {
			fontSize: 13,
			lineHeight: "18px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		const chevronStyle = {
			flex: "0 0 auto",
			fontSize: 18,
			lineHeight: 1,
			transition: "transform 120ms ease"
		};
		const cardBodyStyle = {
			borderTop: "1px solid var(--dsw-alias-border-l2)",
			padding: "16px 14px 18px"
		};
		const bodyStyle = {
			margin: 0,
			fontSize: 14,
			lineHeight: "22px",
			color: "var(--dsw-alias-label-secondary)"
		};
		const rowStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			flexWrap: "wrap",
			gap: 12
		};
		const statusStyle = {
			display: "flex",
			alignItems: "center",
			gap: 9,
			fontSize: 15,
			fontWeight: 500,
			color: "var(--dsw-alias-label-primary)"
		};
		const buttonStyle$1 = {
			boxSizing: "border-box",
			minHeight: 34,
			padding: "6px 14px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 18,
			background: "var(--dsw-alias-bg-layer-1)",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			fontSize: 14,
			cursor: "pointer"
		};
		const errorStyle = {
			...bodyStyle,
			color: "var(--dsw-alias-state-error-primary)"
		};
		const quotaListStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 18,
			paddingTop: 2
		};
		const quotaGroupStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 10
		};
		const quotaTitleStyle = {
			margin: 0,
			fontSize: 14,
			lineHeight: "20px",
			fontWeight: 600,
			color: "var(--dsw-alias-label-primary)"
		};
		const quotaLabelStyle = {
			display: "flex",
			justifyContent: "space-between",
			gap: 12,
			fontSize: 13,
			lineHeight: "20px",
			color: "var(--dsw-alias-label-secondary)"
		};
		const modelBadgeStyle = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			flexWrap: "wrap"
		};
		const modelOfferStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 2
		};
		const modelRateStyle = {
			fontSize: 12,
			lineHeight: "18px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		const modelBadgeChipStyle = {
			padding: "1px 8px",
			borderRadius: 999,
			fontSize: 11,
			lineHeight: "18px",
			background: "var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))",
			color: "var(--dsw-alias-state-success-primary, #22a06b)"
		};
		/**
		* Localize an upstream promotional badge label, with an unknown-badge fallback.
		*
		* The 小浣熊 catalog spells badges in Chinese (`限时免费`, `夜间折扣`). The two
		* known promotions are mapped so they follow the UI language, and anything
		* else passes through verbatim — an unrecognized badge is still information
		* the upstream chose to show, and translating it wrongly is worse than not
		* translating it.
		*/
		function modelBadgeLabel(badge, t) {
			if (badge === "限时免费") return t("badgeLimitedFree");
			if (badge === "夜间折扣") return t("badgeNightDiscount");
			if (badge === "Free now") return t("badgeFreeNow");
			return badge;
		}
		/**
		* Inline confirmation box for a paid detection. A modal alert for a one-line
		* decision is heavier than the action it guards, and `window.confirm` is not
		* available inside the DSH page anyway.
		*/
		const confirmBoxStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 10,
			padding: "10px 12px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8,
			background: "var(--dsw-alias-bg-layer-1)"
		};
		const confirmRowStyle$1 = {
			display: "flex",
			justifyContent: "flex-end",
			gap: 8
		};
		/** One probeable model's row: name on the left, state and action on the right. */
		const probeRowStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 12
		};
		const probeRowEndStyle = {
			display: "inline-flex",
			alignItems: "center",
			gap: 8,
			flex: "0 0 auto"
		};
		/**
		* Tab strip for the card body. Kept visually light — a full pill would compete
		* with the section headings, and the card is already the densest surface the
		* plugin owns.
		*/
		const tabBarStyle = {
			display: "flex",
			gap: 4,
			marginTop: 4,
			borderBottom: "1px solid var(--dsw-alias-border-l2)"
		};
		const tabStyle = {
			padding: "6px 12px",
			border: 0,
			borderBottom: "2px solid transparent",
			background: "transparent",
			color: "var(--dsw-alias-label-tertiary)",
			font: "inherit",
			fontSize: 13,
			lineHeight: "20px",
			cursor: "pointer"
		};
		const tabActiveStyle = {
			borderBottom: "2px solid var(--dsw-alias-brand-primary)",
			color: "var(--dsw-alias-label-primary)",
			fontWeight: 600
		};
		const tabPanelStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 18,
			paddingTop: 16
		};
		/**
		* Primary action of the inline confirmation. Fill and text colour come from the
		* theme as a pair: `brand-primary` is a light accent here, so pairing it with a
		* hardcoded white would render white-on-white.
		*/
		const primaryButtonStyle$1 = {
			...buttonStyle$1,
			minHeight: 0,
			padding: "4px 12px",
			borderRadius: 8,
			border: "1px solid var(--dsw-alias-button-primary-fill)",
			background: "var(--dsw-alias-button-primary-fill)",
			color: "var(--dsw-alias-label-primary-foreground)"
		};
		/**
		* Status dot colour. Takes `'loading'` as well as the document's own states:
		* before the first response the card knows nothing about the account, so it
		* must not borrow the signed-out grey — that would read as "nothing is wrong,
		* nobody is signed in" when the truth is "not read yet".
		*/
		function dotStyle(status) {
			return {
				width: 9,
				height: 9,
				borderRadius: "50%",
				flex: "0 0 auto",
				background: status === "signed-in" ? "var(--dsw-alias-state-success-primary, #22a06b)" : status === "error" ? "var(--dsw-alias-state-error-primary, #d92d20)" : "var(--dsw-alias-label-dimmed, #9aa0a6)"
			};
		}
		function formatNumber(value) {
			return new Intl.NumberFormat(void 0).format(value);
		}
		function formatTime(ms) {
			return new Intl.DateTimeFormat(void 0, {
				dateStyle: "medium",
				timeStyle: "short"
			}).format(new Date(ms));
		}
		/**
		* Compact token count for display: the catalog's own round numbers (`200000`,
		* `1000000`) read better as `200K` / `1M`, and no precision is lost because
		* these values are always whole thousands.
		*/
		function formatTokens(tokens) {
			if (tokens >= 1e6 && tokens % 1e6 === 0) return `${tokens / 1e6}M`;
			if (tokens >= 1e3 && tokens % 1e3 === 0) return `${tokens / 1e3}K`;
			return String(tokens);
		}
		/** The locale key naming one catalog source. */
		function catalogSourceKey(source) {
			return source === "live" ? "catalogSourceLive" : source === "saved" ? "catalogSourceSaved" : "catalogSourceFallback";
		}
		/**
		* One model offer row: name, promotional badges, and the billing rate.
		*
		* The rate sits under the name rather than beside it because the row already
		* spends its horizontal budget on badges; stacking keeps long model names and
		* several badges from squeezing the rate into an ellipsis.
		*/
		function ModelOfferRow({ model, t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: modelOfferStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: quotaLabelStyle,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: model.name }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: modelBadgeStyle,
						children: [model.badges?.map((badge) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: modelBadgeChipStyle,
							children: modelBadgeLabel(badge, t)
						}, badge)), model.free === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: modelBadgeChipStyle,
							children: t("freeModel")
						}) : null]
					})]
				}), model.credits === void 0 ? model.rateUnknown === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: modelRateStyle,
					children: t("rateUnknown")
				}) : null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: modelRateStyle,
					children: t("rate", { rate: model.credits })
				})]
			});
		}
		/**
		* Per-model context capacity, output ceiling, and image-reading capability.
		*
		* Purely a report of the upstream's own numbers: rows with none of the three
		* fields are omitted (the catalog declared nothing to say), largest window
		* first, and `vision === undefined` renders no chip at all — "the catalog does
		* not tag this model" is not the same claim as "this model cannot read images".
		*/
		function ContextTable({ models, t }) {
			const known = (models ?? []).filter((model) => model.contextWindow !== void 0 || model.maxTokens !== void 0 || model.vision !== void 0).sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0));
			if (known.length === 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: quotaListStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
					style: quotaTitleStyle,
					children: t("contextHeading")
				}), known.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: quotaLabelStyle,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: model.name }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: modelOfferStyle,
						children: [
							model.contextWindow === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { textAlign: "right" },
								children: t("contextWindow", { size: formatTokens(model.contextWindow) })
							}),
							model.maxTokens === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: modelRateStyle,
								children: t("contextMaxOutput", { size: formatTokens(model.maxTokens) })
							}),
							model.vision === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: modelRateStyle,
								children: t(model.vision ? "visionYes" : "visionNo")
							})
						]
					})]
				}, model.id))]
			});
		}
		/**
		* Reasoning-effort detection section: consent state, per-model detection, and
		* the recorded observations.
		*
		* Two deliberate UX rules:
		* - the confirmation is shown *before* any request, and its copy states the
		*   credit caveat; the document's `consent` flag is reported as a line so the
		*   user can see whether sweeps were authorized, never silently;
		* - a `non-validating` result is presented as an observation about the
		*   parameter ("this model does not check it"), never as a statement that a
		*   level is unsupported.
		*/
		function ProbeSection({ probe, t, onDetect, onClear, busy }) {
			const [pending, setPending] = (0, react.useState)();
			const [runningModel, setRunningModel] = (0, react.useState)();
			(0, react.useEffect)(() => {
				if (pending !== void 0 && !probe.candidates.includes(pending)) setPending(void 0);
			}, [pending, probe.candidates]);
			const runningArmed = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				if (runningModel === void 0) return;
				if (busy || probe.running) {
					runningArmed.current = true;
					return;
				}
				if (!runningArmed.current) return;
				runningArmed.current = false;
				setRunningModel(void 0);
			}, [
				runningModel,
				busy,
				probe.running
			]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: quotaListStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						style: quotaTitleStyle,
						children: t("probeHeading")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle,
						children: t("probeIntro")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle,
						children: t("probeConsentHint")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle,
						children: t(probe.consent ? "probeConsentOn" : "probeConsentOff")
					}),
					probe.running ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle,
						children: t("probeRunningGeneric")
					}) : null,
					probe.candidates.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle,
						children: t("probeResultEmpty")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: quotaGroupStyle,
						children: probe.candidates.map((id) => {
							const result = probe.results.find((entry) => entry.id === id);
							const name = result?.name ?? id;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: modelOfferStyle,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: probeRowStyle,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: name }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											style: probeRowEndStyle,
											children: [result === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: modelBadgeChipStyle,
												children: result.validation === "validating" ? result.efforts.length > 0 ? result.efforts.join(" / ") : t("probeResultNoLevels") : t(result.validation === "non-validating" ? "probeResultNotValidating" : "probeResultUnknown")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												style: buttonStyle$1,
												disabled: probe.running || busy,
												onClick: () => {
													setPending(id);
												},
												children: runningModel === id ? t("probeRunning", { model: id }) : t(result === void 0 ? "probeStart" : "probeRedetect")
											})]
										})]
									}),
									result === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: modelRateStyle,
										children: t("probeResultAt", { time: formatTime(result.probedAt) })
									}),
									pending === id ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: confirmBoxStyle,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: bodyStyle,
											children: t("probeConfirmBody", { model: name })
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: confirmRowStyle$1,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												style: buttonStyle$1,
												onClick: () => {
													setPending(void 0);
												},
												children: t("cancel")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												style: primaryButtonStyle$1,
												disabled: probe.running || busy,
												onClick: () => {
													setRunningModel(id);
													setPending(void 0);
													onDetect(id);
												},
												children: t("probeConfirmAction")
											})]
										})]
									}) : null
								]
							}, id);
						})
					}),
					probe.results.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						style: buttonStyle$1,
						disabled: busy,
						onClick: () => {
							onClear();
						},
						children: t("probeClear")
					})
				]
			});
		}
		/** Render 小浣熊 sign-in state, catalog provenance, and credit as one expandable card. */
		function RaccoonPluginCard({ t, variant = RACCOON_CARD }) {
			if (t === void 0) throw new Error("Raccoon plugin card requires its translation function");
			const [open, setOpen] = (0, react.useState)(false);
			/**
			* The document to render. `undefined` means *not read yet*, which is a
			* distinct state from "signed out": seeding this with a signed-out document
			* told an already-signed-in user they were signed out for the whole first
			* round trip (and forever, if the read never settled).
			*/
			const [status, setStatus] = (0, react.useState)();
			/**
			* Whether the last **successful** read found a usable credential.
			*
			* Kept apart from `status` because the poll's liveness must depend on what the
			* account actually is, not on what the card last displayed: a failed read
			* leaves this untouched, so a transient failure cannot disarm the interval,
			* while a genuine signed-out answer still stops it.
			*
			* `undefined` therefore means "no successful read yet", which is also the
			* condition that decides whether a failed read has anything to preserve.
			*/
			const [signedIn, setSignedIn] = (0, react.useState)();
			/**
			* Why the most recent read failed, when it did. Rendered as a notice beside
			* whatever document is still on screen, rather than replacing it.
			*/
			const [readFailure, setReadFailure] = (0, react.useState)();
			const [busy, setBusy] = (0, react.useState)(false);
			const [tab, setTab] = (0, react.useState)("status");
			const mounted = (0, react.useRef)(true);
			/**
			* Identity of the newest read that may write. Assigned when a read *starts*,
			* so a response is superseded by anything begun after it — "the response whose
			* request started last wins". Without this, a slow poll begun before a manual
			* action could settle after the action's own refresh and restore the older
			* document.
			*/
			const readSeq = (0, react.useRef)(0);
			/** Manual requests in flight, so unmount can abort them like the poll's. */
			const manualControllers = (0, react.useRef)(/* @__PURE__ */ new Set());
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
					for (const controller of manualControllers.current) controller.abort();
					manualControllers.current.clear();
				};
			}, []);
			/** Register a manual request's controller so unmount aborts it. */
			const trackController = (0, react.useCallback)(() => {
				const controller = new AbortController();
				manualControllers.current.add(controller);
				return controller;
			}, []);
			/**
			* Read the status document and apply it under the two policies the card's
			* correctness rests on:
			*
			* - a non-document body (empty, `null`, a non-JSON page) is a failed read, not
			*   something to store and then dereference in the render;
			* - a failed read never discards a document already on screen. It is recorded
			*   and shown as a notice beside that document; only when nothing has been
			*   read yet does the failure itself become the rendered state.
			*
			* Returns whether this read produced the current document.
			*/
			const refresh = (0, react.useCallback)(async (signal) => {
				const seq = ++readSeq.current;
				const current = () => mounted.current && signal?.aborted !== true && seq === readSeq.current;
				try {
					const response = await fetch(variant.statusPath, {
						headers: { accept: "application/json" },
						credentials: "same-origin",
						...signal === void 0 ? {} : { signal }
					});
					const value = await response.json().catch(() => void 0);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					if (!isRaccoonWebStatus(value)) throw new Error(t("statusResponseInvalid"));
					if (!current()) return false;
					setStatus(value);
					if (value.status === "signed-in") setSignedIn(true);
					else if (value.status === "signed-out") setSignedIn(false);
					setReadFailure(void 0);
					return true;
				} catch (error) {
					const message = error instanceof Error ? error.message : t("requestFailed");
					if (current()) {
						setReadFailure(message);
						setStatus((previous) => previous === void 0 ? {
							status: "error",
							message
						} : previous);
					}
					return false;
				}
			}, [t, variant.statusPath]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const controller = new AbortController();
				refresh(controller.signal);
				return () => {
					controller.abort();
				};
			}, [open, refresh]);
			(0, react.useEffect)(() => {
				if (!open || signedIn === false) return;
				const controller = new AbortController();
				const timer = window.setInterval(() => {
					refresh(controller.signal);
				}, POLL_INTERVAL_MS);
				return () => {
					window.clearInterval(timer);
					controller.abort();
				};
			}, [
				open,
				refresh,
				signedIn
			]);
			const manualRefresh = async () => {
				setBusy(true);
				const controller = trackController();
				try {
					await refresh(controller.signal);
				} finally {
					manualControllers.current.delete(controller);
					if (mounted.current) setBusy(false);
				}
			};
			/**
			* Ask the host to re-read the credential and re-fetch this variant's catalog.
			*
			* Shares the probe route's key and guards: it is a write that spends an
			* upstream request, so it does not belong on the read-only status GET. A
			* failure is surfaced through the refreshed document's `catalog.error` rather
			* than thrown away, so the reason survives the round trip.
			*/
			const refreshModels = (0, react.useCallback)(async () => {
				const key = status?.status === "signed-in" ? status.probeKey : void 0;
				if (key === void 0) return;
				setBusy(true);
				const controller = trackController();
				try {
					const response = await fetch(variant.probePath, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Raccoon-Probe-Key": key
						},
						credentials: "same-origin",
						signal: controller.signal,
						body: JSON.stringify({ action: "refresh" })
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
				} catch (error) {
					if (mounted.current && controller.signal.aborted !== true) setReadFailure(error instanceof Error ? error.message : t("requestFailed"));
					manualControllers.current.delete(controller);
					return;
				} finally {
					if (mounted.current) setBusy(false);
				}
				try {
					await refresh(controller.signal);
				} finally {
					manualControllers.current.delete(controller);
				}
			}, [
				refresh,
				status,
				t,
				trackController,
				variant.probePath
			]);
			/**
			* Run one control action and refresh the card's state afterwards.
			*
			* The key travels in a header, not the body: it authorizes the write, and
			* the host never accepts a prompt, a sentinel, or a model outside its own
			* catalog from here. `probe` and `clear` only — `refresh` is the dedicated
			* {@link refreshModels} path above.
			*/
			const control = (0, react.useCallback)(async (action) => {
				const key = status?.status === "signed-in" ? status.probeKey : void 0;
				if (key === void 0) return;
				setBusy(true);
				const controller = trackController();
				try {
					const response = await fetch(variant.probePath, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Raccoon-Probe-Key": key
						},
						credentials: "same-origin",
						signal: controller.signal,
						body: JSON.stringify(action)
					});
					const value = await response.json().catch(() => void 0);
					if (!response.ok) {
						const message = typeof value === "object" && value !== null && "error" in value ? String(value["error"]) : `HTTP ${response.status}`;
						throw new Error(message);
					}
					await refresh(controller.signal);
				} catch (error) {
					if (mounted.current && controller.signal.aborted !== true) setReadFailure(error instanceof Error ? error.message : t("requestFailed"));
				} finally {
					manualControllers.current.delete(controller);
					if (mounted.current) setBusy(false);
				}
			}, [
				refresh,
				status,
				t,
				trackController,
				variant.probePath
			]);
			/**
			* Start a detection. Confirmation happens inline in the section, so this is
			* only ever called after the user has already agreed to spend credit.
			*/
			const confirmDetect = (0, react.useCallback)((modelId) => {
				control({
					action: "probe",
					model: modelId
				});
			}, [control]);
			const title = t("title", { name: variant.displayName });
			const label = status === void 0 ? t("loading") : status.status === "signed-in" ? status.nickname === void 0 ? t("signedInAs", { nickname: "" }).trimEnd().replace(/[:：]$/, "") : t("signedInAs", { nickname: status.nickname }) : status.status === "error" ? t("requestFailed") : t("signedOut");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				style: cardStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					style: headerStyle,
					"aria-expanded": open,
					"aria-label": `${t(open ? "collapse" : "expand")}: ${title}`,
					onClick: () => {
						setOpen(!open);
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: headTextStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: nameStyle,
							children: title
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: descriptionStyle,
							children: t("intro", { name: variant.displayName })
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						"aria-hidden": "true",
						style: {
							...chevronStyle,
							transform: open ? "rotate(180deg)" : "none"
						},
						children: "⌄"
					})]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: cardBodyStyle,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							style: quotaTitleStyle,
							children: t("accountHeading")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: rowStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: statusStyle,
								role: "status",
								"aria-busy": status === void 0,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									"aria-hidden": "true",
									style: dotStyle(status === void 0 ? "loading" : status.status)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label })]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: buttonStyle$1,
								disabled: busy,
								onClick: () => {
									manualRefresh();
								},
								children: busy ? t("refreshing") : t("refresh")
							})]
						}),
						readFailure === void 0 || signedIn === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: errorStyle,
							children: t("statusRefreshFailed", { message: readFailure })
						}),
						status?.status === "signed-in" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							role: "tablist",
							style: tabBarStyle,
							children: [
								"status",
								"context",
								"details"
							].map((id) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								role: "tab",
								"aria-selected": tab === id,
								onClick: () => {
									setTab(id);
								},
								style: {
									...tabStyle,
									...tab === id ? tabActiveStyle : {}
								},
								children: t(id === "status" ? "tabStatus" : id === "context" ? "tabContext" : "tabDetails")
							}, id))
						}), tab === "status" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: tabPanelStyle,
							children: [
								status.identity === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: bodyStyle,
									children: status.identity === "personal" ? t("identityPersonal") : t("identityOrg", { identity: status.identity })
								}),
								status.orgName === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: bodyStyle,
									children: t("orgName", { name: status.orgName })
								}),
								status.source === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: bodyStyle,
									children: t("credentialSource", { source: status.source === "desktop" ? t("sourceDesktop", { name: variant.displayName }) : t("sourceDsh") })
								}),
								status.expiresAt === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: bodyStyle,
									children: t("accessTokenExpires", { time: formatTime(status.expiresAt) })
								}),
								status.refreshExpiresAt === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: bodyStyle,
									children: t("refreshTokenExpires", { time: formatTime(status.refreshExpiresAt) })
								}),
								status.catalog === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: rowStyle,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: bodyStyle,
										children: [t("catalogSourceLine", { source: t(catalogSourceKey(status.catalog.source)) }), status.catalog.fetchedAt === void 0 ? "" : ` · ${t("catalogFetchedAt", { time: formatTime(status.catalog.fetchedAt) })}`]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: buttonStyle$1,
										disabled: busy,
										onClick: () => {
											refreshModels();
										},
										children: busy ? t("refreshingModels") : t("refreshModels")
									})]
								}),
								status.catalog?.error === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: errorStyle,
									children: t("catalogError", { message: status.catalog.error })
								}),
								status.probe === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProbeSection, {
									probe: status.probe,
									t,
									busy,
									onDetect: confirmDetect,
									onClear: () => {
										control({ action: "clear" });
									}
								})
							]
						}) : tab === "context" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: tabPanelStyle,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ContextTable, {
								models: status.models,
								t
							})
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: tabPanelStyle,
							children: [status.points === void 0 && status.pointsError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: quotaListStyle,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
										style: quotaTitleStyle,
										children: t("pointsHeading")
									}),
									status.points?.total === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										style: bodyStyle,
										children: t("pointsTotal", { total: formatNumber(status.points.total) })
									}),
									status.points?.plan === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										style: bodyStyle,
										children: t("pointsPlan", { plan: status.points.plan })
									}),
									status.points?.note === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										style: bodyStyle,
										children: t("pointsNote", { note: status.points.note })
									}),
									status.pointsError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										style: errorStyle,
										children: t("pointsError", { message: status.pointsError })
									})
								]
							}), (() => {
								const priced = (status.models ?? []).filter((model) => model.free === true || (model.badges?.length ?? 0) > 0 || model.credits !== void 0 || model.rateUnknown === true);
								if (priced.length === 0) return null;
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: quotaListStyle,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
										style: quotaTitleStyle,
										children: t("modelsHeading")
									}), priced.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelOfferRow, {
										model,
										t
									}, model.id))]
								});
							})()]
						})] }) : null,
						status?.status === "signed-out" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: status.reason === void 0 ? bodyStyle : errorStyle,
							children: status.reason ?? t("signedOutHint", { name: variant.displayName })
						}) : null,
						status?.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: errorStyle,
							children: status.message
						}) : null
					]
				}) : null]
			});
		}
		//#endregion
		//#region src/client/RaccoonProbeControl.tsx
		/**
		* Per-model reasoning-effort entry beside the Composer's model selector.
		*
		* The interaction is the established shape for composer chrome here:
		*
		* - a **static inline label** next to the icon names the feature ("Reasoning
		*   levels"), set smaller and dimmer than the surrounding chrome so it reads as
		*   an annotation on the icon. It never carries state: the verified levels
		*   already appear in the model dropdown (the adapter exposes them as
		*   selectable efforts), so repeating them here would duplicate the real answer
		*   and make the label's width jump as results change.
		* - a **hover/focus tooltip** carries the state and the click's purpose.
		* - the **confirmation** is a small bubble anchored to the control, not a
		*   `window.confirm`. Probing spends real credit, so a confirmation stays —
		*   but it belongs next to the thing it acts on, sized to one line plus two
		*   small buttons.
		*
		* Selection comes from the session's shared model directory (the same store
		* the composer's model seat renders), so the entry follows a model switch made
		* anywhere, and it disappears for any provider that is not a 小浣熊 variant.
		*
		* @module dsh-raccoon-connect/client/probe-control
		*/
		/**
		* The card (and therefore the routes) a selected provider belongs to.
		*
		* The control sits in one seat for every session, so the provider id is what
		* selects the status and probe endpoints. Returning `undefined` for any other
		* provider is what keeps the icon off every non-小浣熊 model.
		*/
		function cardVariantFor(provider) {
			return CARD_VARIANTS.find((card) => card.id === provider);
		}
		/** How often the control re-checks state when the window regains focus. */
		const RECONCILE_MS = 6e4;
		const wrapperStyle = {
			display: "inline-flex",
			position: "relative",
			alignItems: "center",
			transform: "translateY(2px)",
			marginRight: -8
		};
		const buttonStyle = {
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			gap: 2,
			height: 30,
			padding: "0 6px",
			border: 0,
			borderRadius: 8,
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			font: "inherit",
			whiteSpace: "nowrap",
			cursor: "pointer"
		};
		/**
		* The inline label. Smaller and dimmer than the surrounding chrome on purpose:
		* it names the feature, so it should read as an annotation attached to the icon
		* rather than compete with the adjacent model selector.
		*/
		const labelStyle = {
			fontSize: 11,
			lineHeight: "16px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		/** Tooltip bubble: one line, nowrap, above the control. */
		const tooltipStyle = {
			position: "absolute",
			left: "50%",
			bottom: "calc(100% + 8px)",
			zIndex: 1e3,
			transform: "translateX(-50%)",
			padding: "4px 8px",
			borderRadius: 6,
			background: "var(--dsw-specific-tip, #1f2329)",
			boxShadow: "var(--dsw-shadow-lv2)",
			color: "var(--dsw-alias-label-primary, #fff)",
			fontSize: 12,
			lineHeight: "18px",
			whiteSpace: "nowrap",
			pointerEvents: "none"
		};
		/** Confirmation bubble: same anchor, but interactive and allowed to wrap. */
		const confirmStyle = {
			position: "absolute",
			right: 0,
			bottom: "calc(100% + 8px)",
			zIndex: 1001,
			display: "flex",
			flexDirection: "column",
			gap: 8,
			width: 260,
			padding: "10px 12px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8,
			background: "var(--dsw-alias-bg-layer-1, #fff)",
			boxShadow: "var(--dsw-shadow-lv2)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 12,
			lineHeight: "18px"
		};
		const confirmRowStyle = {
			display: "flex",
			justifyContent: "flex-end",
			gap: 8
		};
		const confirmButtonStyle = {
			padding: "3px 10px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 6,
			background: "transparent",
			color: "inherit",
			font: "inherit",
			fontSize: 12,
			cursor: "pointer"
		};
		/**
		* Primary action inside the confirmation bubble.
		*
		* The fill and its text colour must come as a pair: `brand-primary` resolves to
		* a light accent in this theme, so hardcoding `color: #fff` on top of it
		* renders white-on-white. `button-primary-fill` + `label-primary-foreground`
		* is the theme's own pair for exactly this.
		*/
		const primaryButtonStyle = {
			...confirmButtonStyle,
			border: "1px solid var(--dsw-alias-button-primary-fill)",
			background: "var(--dsw-alias-button-primary-fill)",
			color: "var(--dsw-alias-label-primary-foreground)"
		};
		/**
		* Result note: a single line + a dismiss button, anchored to the control's
		* right side. Smaller than the confirmation bubble because it carries an
		* *outcome*, not a *decision* — the work is done, the user only has to read
		* and dismiss.
		*/
		const noteStyle = {
			position: "absolute",
			right: 0,
			bottom: "calc(100% + 8px)",
			zIndex: 1001,
			display: "flex",
			alignItems: "center",
			gap: 12,
			padding: "6px 10px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8,
			background: "var(--dsw-alias-bg-layer-1)",
			boxShadow: "var(--dsw-shadow-lv2)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 12,
			lineHeight: "18px",
			whiteSpace: "nowrap"
		};
		/**
		* The note's dismiss action. Outlined rather than bare text: inside an already
		* bordered bubble, an unbordered word does not read as something you can click.
		*/
		const noteDismissStyle = {
			padding: "2px 8px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 6,
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			font: "inherit",
			fontSize: 12,
			lineHeight: "18px",
			cursor: "pointer"
		};
		/** Pick the model's recorded observation out of the probe section. */
		function resultFor(status, model) {
			if (status.status !== "signed-in") return void 0;
			return status.probe?.results.find((result) => result.id === model);
		}
		/**
		* The one-line tooltip: current state first, then what a click does.
		*
		* A recorded result outranks a remembered failure. `failed` only means "the
		* last run from this control did not complete"; the host can record a result
		* for the same model at any time (a detection started from the settings card,
		* another conversation, or a finished sweep), and the levels the user paid for
		* are the more useful answer than the stale failure. Failure copy is what
		* remains when there is no result to report.
		*/
		function tooltipText(t, model, state) {
			if (state.busy) return t("probeRunning", { model });
			const result = state.result;
			if (result !== void 0) {
				if (result.validation === "validating" && result.efforts.length > 0) return t("probeTooltipVerified", { levels: result.efforts.join(" / ") });
				if (result.validation === "non-validating") return t("probeTooltipNotValidating");
				return t("probeTooltipRetry");
			}
			if (state.failed) return t("probeTooltipRetry");
			return t("probeTooltipIdle", { model });
		}
		/** Compose the one-line outcome string the note bubble shows. */
		function noteText(t, result) {
			if (result.validation === "validating" && result.efforts.length > 0) return t("probeNoteVerified", { levels: result.efforts.join(" / ") });
			if (result.validation === "non-validating") return t("probeNoteNotValidating");
			return t("probeNoteUnknown");
		}
		/** Model-independent shell: resolves the session's selection, then delegates per model. */
		function RaccoonProbeControl({ directory, t }) {
			if (t === void 0) throw new Error("Raccoon probe control requires its translation function");
			const subscribe = (0, react.useCallback)((listener) => directory.subscribe(listener), [directory]);
			const snapshot = (0, react.useCallback)(() => directory.getSnapshot(), [directory]);
			const selection = (0, react.useSyncExternalStore)(subscribe, snapshot, snapshot).current;
			const card = selection === void 0 || selection === null ? void 0 : cardVariantFor(selection.provider);
			const key = card === void 0 || selection === void 0 || selection === null ? void 0 : `${card.id}:${selection.model}`;
			return card === void 0 || key === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelProbe, {
				model: selection.model,
				card,
				t
			}, key);
		}
		function ModelProbe({ model, card, t }) {
			const [status, setStatus] = (0, react.useState)();
			const [busy, setBusy] = (0, react.useState)(false);
			const [confirming, setConfirming] = (0, react.useState)(false);
			const [tooltipVisible, setTooltipVisible] = (0, react.useState)(false);
			const [failed, setFailed] = (0, react.useState)(false);
			const [note, setNote] = (0, react.useState)();
			const inFlight = (0, react.useRef)(false);
			const mounted = (0, react.useRef)(false);
			const readSeq = (0, react.useRef)(0);
			const tooltipId = (0, react.useId)();
			const refresh = (0, react.useCallback)(async (signal) => {
				const seq = ++readSeq.current;
				const response = await fetch(card.statusPath, {
					credentials: "same-origin",
					headers: { accept: "application/json" },
					...signal === void 0 ? {} : { signal }
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const value = await response.json().catch(() => void 0);
				if (!isRaccoonWebStatus(value)) throw new Error(t("statusResponseInvalid"));
				if (mounted.current && signal?.aborted !== true && seq === readSeq.current) setStatus(value);
			}, [card.statusPath, t]);
			(0, react.useEffect)(() => {
				mounted.current = true;
				const controller = new AbortController();
				const load = () => {
					refresh(controller.signal).catch(() => {});
				};
				load();
				const timer = window.setInterval(load, RECONCILE_MS);
				window.addEventListener("focus", load);
				return () => {
					mounted.current = false;
					controller.abort();
					window.clearInterval(timer);
					window.removeEventListener("focus", load);
				};
			}, [refresh]);
			const probe = status?.status === "signed-in" ? status.probe : void 0;
			const probeKey = status?.status === "signed-in" ? status.probeKey : void 0;
			const result = status === void 0 ? void 0 : resultFor(status, model);
			const visible = probe?.candidates.includes(model) === true || result !== void 0;
			(0, react.useEffect)(() => {
				if (result !== void 0) setFailed(false);
			}, [result]);
			const detect = async () => {
				if (probeKey === void 0 || inFlight.current || probe?.running === true) return;
				inFlight.current = true;
				setNote(void 0);
				setConfirming(false);
				setBusy(true);
				setFailed(false);
				try {
					const response = await fetch(card.probePath, {
						method: "POST",
						credentials: "same-origin",
						headers: {
							"Content-Type": "application/json",
							"X-Raccoon-Probe-Key": probeKey
						},
						body: JSON.stringify({
							action: "probe",
							model
						})
					});
					const body = await response.json();
					if (!response.ok || body.state !== "ok" || body.validation !== "validating" && body.validation !== "non-validating" || !Array.isArray(body.efforts) || !body.efforts.every((effort) => typeof effort === "string")) throw new Error("probe failed");
					if (mounted.current) {
						const completed = {
							id: model,
							name: model,
							validation: body.validation,
							efforts: body.efforts,
							probedAt: Date.now()
						};
						setNote(completed);
					}
					refresh().catch(() => {});
				} catch {
					if (mounted.current) setFailed(true);
				} finally {
					inFlight.current = false;
					if (mounted.current) setBusy(false);
				}
			};
			if (!visible) return null;
			const text = tooltipText(t, model, {
				busy,
				result,
				failed
			});
			const disabled = busy || probe?.running === true || probeKey === void 0;
			const showTooltip = tooltipVisible && !confirming && note === void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				style: wrapperStyle,
				onMouseEnter: () => {
					setTooltipVisible(true);
				},
				onMouseLeave: () => {
					setTooltipVisible(false);
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						"aria-label": text,
						"aria-describedby": showTooltip ? tooltipId : void 0,
						"aria-busy": busy,
						"aria-expanded": confirming,
						disabled,
						onClick: () => {
							setConfirming(true);
						},
						onFocus: () => {
							setTooltipVisible(true);
						},
						onBlur: () => {
							setTooltipVisible(false);
						},
						style: {
							...buttonStyle,
							opacity: disabled && !confirming ? .6 : 1,
							cursor: disabled ? "default" : "pointer"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
							width: "16",
							height: "16",
							viewBox: "0 0 24 24",
							fill: "none",
							stroke: "currentColor",
							strokeWidth: "1.6",
							"aria-hidden": "true",
							focusable: "false",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
									cx: "12",
									cy: "12",
									r: "9"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
									cx: "12",
									cy: "12",
									r: "4"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M12 12 20 4" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
									cx: "12",
									cy: "12",
									r: "1"
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: labelStyle,
							children: t("probeLabel")
						})]
					}),
					showTooltip && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						id: tooltipId,
						role: "tooltip",
						style: tooltipStyle,
						children: text
					}),
					confirming && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: confirmStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("probeBubbleBody") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: confirmRowStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: confirmButtonStyle,
								onClick: () => {
									setConfirming(false);
								},
								children: t("cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: primaryButtonStyle,
								onClick: () => {
									detect();
								},
								children: t("probeConfirmAction")
							})]
						})]
					}),
					note === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						role: "status",
						"aria-live": "polite",
						style: noteStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: noteText(t, note) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: noteDismissStyle,
							onClick: () => {
								setNote(void 0);
							},
							children: t("probeNoteDismiss")
						})]
					})
				]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* Plugin-card copy registered under the `settings.raccoon` locale namespace.
		*
		* `en` is the key authority: `RaccoonSettingsKey` derives from it and `zh` is
		* annotated `Record<RaccoonSettingsKey, string>`, so a key added to one language
		* but not the other is a compile error rather than a runtime key-name shown to
		* the user. Names of the product are never hardcoded in a string that a second
		* variant would have to fork: they take `{name}` and the card passes the variant
		* descriptor's displayName.
		*/
		const en = {
			title: "DSH {name} Connect",
			intro: "Use the models in the {name} desktop app directly in DSH — zero configuration, ready out of the box.",
			expand: "Expand",
			collapse: "Collapse",
			loading: "Loading account…",
			signedOut: "Not signed in",
			signedOutHint: "Sign in once in the {name} desktop app; this plugin follows that sign-in automatically.",
			signedInAs: "Signed in as {nickname}",
			accountHeading: "Account",
			tabStatus: "Status",
			tabContext: "Context",
			tabDetails: "Details",
			identityPersonal: "Personal account",
			identityOrg: "Organization identity: {identity}",
			orgName: "Organization: {name}",
			credentialSource: "Credential: {source}",
			sourceDesktop: "{name} app’s own file",
			sourceDsh: "plugin-owned copy",
			accessTokenExpires: "Access token expires {time} (refresh is automatic)",
			refreshTokenExpires: "Refresh token expires {time}",
			catalogSourceLine: "Model list source: {source}",
			catalogSourceLive: "live",
			catalogSourceSaved: "saved",
			catalogSourceFallback: "built-in fallback",
			catalogFetchedAt: "updated {time}",
			catalogError: "Last update failed: {message}",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			refreshModels: "Refresh model list",
			refreshingModels: "Refreshing models…",
			requestFailed: "Request failed",
			statusRefreshFailed: "Refresh failed: {message} — showing the last known state",
			statusResponseInvalid: "Raccoon returned an unreadable status reply",
			pointsHeading: "Remaining credit",
			pointsTotal: "Total: {total}",
			pointsPlan: "Plan: {plan}",
			pointsNote: "Note: {note}",
			pointsError: "Credit lookup failed: {message}",
			modelsHeading: "Model rates",
			contextHeading: "Context window",
			contextWindow: "context {size}",
			contextMaxOutput: "max output {size}",
			visionYes: "reads images",
			visionNo: "text only",
			freeModel: "Free",
			badgeLimitedFree: "Limited-time free",
			badgeNightDiscount: "Night discount",
			badgeFreeNow: "Free now",
			rate: "{rate} credits per message",
			rateUnknown: "Price unavailable — refresh to update",
			probeHeading: "Reasoning effort detection",
			probeIntro: "Some models reason but declare no selectable effort levels. Detecting which levels a model accepts sends a few real requests that may consume credit.",
			probeConsentHint: "Each detection sends test requests to one model to confirm its available reasoning levels, and may consume a small amount of credit.",
			probeConsentOn: "Credit-spending detection is authorized",
			probeConsentOff: "Credit-spending detection is not authorized; confirming below authorizes only this run",
			probeLabel: "Reasoning levels",
			probeTooltipIdle: "Detect the reasoning levels {model} accepts",
			probeTooltipVerified: "Accepted levels: {levels} · click to detect again",
			probeTooltipNotValidating: "This model does not check the effort parameter",
			probeTooltipRetry: "Detection did not complete · click to retry",
			probeBubbleBody: "Send test requests to confirm the available reasoning levels. May consume a small amount of credit.",
			probeConfirmAction: "Confirm",
			probeNoteVerified: "Detected: {levels}",
			probeNoteNotValidating: "This model does not check the effort parameter",
			probeNoteUnknown: "Detection did not complete",
			probeNoteDismiss: "Got it",
			probeStart: "Detect",
			probeRedetect: "Detect again",
			probeRunning: "Detecting {model}…",
			probeRunningGeneric: "Detecting…",
			probeClear: "Clear detected results",
			probeConfirmBody: "Send test requests to {model} to confirm its available reasoning levels. May consume a small amount of credit.",
			cancel: "Cancel",
			probeResultVerified: "Verified levels: {levels}",
			probeResultNoLevels: "No tested levels were accepted.",
			probeResultNotValidating: "This model does not check the effort parameter",
			probeResultUnknown: "Detection did not complete",
			probeResultAt: "Detected {time}",
			probeResultEmpty: "No detectable models right now."
		};
		/**
		* Chinese copy, keyed against `en` by the annotation: the compiler, not a code
		* review, guarantees the two dictionaries carry the same keys.
		*/
		const zh = {
			title: "DSH {name} Connect",
			intro: "在 DSH 中直接使用{name}桌面 App 包含的模型，开箱即用，无需额外配置。",
			expand: "展开",
			collapse: "收起",
			loading: "正在读取账号…",
			signedOut: "未登录",
			signedOutHint: "在{name}桌面 App 里登录一次即可，插件会自动跟随当前登录的账号。",
			signedInAs: "已登录：{nickname}",
			accountHeading: "账号",
			tabStatus: "状态",
			tabContext: "上下文",
			tabDetails: "明细",
			identityPersonal: "个人账号",
			identityOrg: "组织身份：{identity}",
			orgName: "组织：{name}",
			credentialSource: "登录凭据：{source}",
			sourceDesktop: "{name} App 自身的凭据文件",
			sourceDsh: "插件保存的凭据副本",
			accessTokenExpires: "访问令牌 {time} 过期（自动续期）",
			refreshTokenExpires: "刷新令牌 {time} 过期",
			catalogSourceLine: "模型列表来源：{source}",
			catalogSourceLive: "实时",
			catalogSourceSaved: "已保存",
			catalogSourceFallback: "内置兜底",
			catalogFetchedAt: "更新于 {time}",
			catalogError: "上次更新失败：{message}",
			refresh: "刷新",
			refreshing: "正在刷新…",
			refreshModels: "刷新模型列表",
			refreshingModels: "正在刷新模型…",
			requestFailed: "请求失败",
			statusRefreshFailed: "刷新失败：{message} — 当前显示的是上次成功获取的状态",
			statusResponseInvalid: "小浣熊返回的状态数据无法识别",
			pointsHeading: "剩余积分",
			pointsTotal: "合计：{total}",
			pointsPlan: "套餐：{plan}",
			pointsNote: "备注：{note}",
			pointsError: "积分查询失败：{message}",
			modelsHeading: "模型价格",
			contextHeading: "上下文窗口",
			contextWindow: "上下文 {size}",
			contextMaxOutput: "最大输出 {size}",
			visionYes: "支持读图",
			visionNo: "不支持读图",
			freeModel: "免费",
			badgeLimitedFree: "限时免费",
			badgeNightDiscount: "夜间折扣",
			badgeFreeNow: "限时免费",
			rate: "{rate} 积分/次",
			rateUnknown: "价格未知 — 刷新后更新",
			probeHeading: "推理档位检测",
			probeIntro: "部分模型具备思考能力，但没有声明可选档位。检测会发送少量真实请求，可能消耗积分。",
			probeConsentHint: "每次检测会向该模型发送探测请求，以确认可用推理档位，可能消耗少量积分。",
			probeConsentOn: "已授权消耗积分进行检测",
			probeConsentOff: "未授权消耗积分检测；下方的确认仅对本次检测有效",
			probeLabel: "推理等级",
			probeTooltipIdle: "检测 {model} 可用的推理档位",
			probeTooltipVerified: "已接受：{levels} · 点击可重新检测",
			probeTooltipNotValidating: "该模型不校验该参数",
			probeTooltipRetry: "检测未完成 · 点击重试",
			probeBubbleBody: "发送探测请求以确认可用推理档位。可能消耗少量积分。",
			probeConfirmAction: "确认检测",
			probeNoteVerified: "已检测：{levels}",
			probeNoteNotValidating: "该模型不校验该参数",
			probeNoteUnknown: "检测未完成",
			probeNoteDismiss: "知道了",
			probeStart: "检测",
			probeRedetect: "重新检测",
			probeRunning: "正在检测 {model}…",
			probeRunningGeneric: "正在检测…",
			probeClear: "清除已探测结果",
			probeConfirmBody: "向 {model} 发送探测请求，以确认可用推理档位。可能消耗少量积分。",
			cancel: "取消",
			probeResultVerified: "已验证接受的档位：{levels}",
			probeResultNoLevels: "本次测试的档位均未被接受。",
			probeResultNotValidating: "该模型不校验该参数",
			probeResultUnknown: "检测未完成",
			probeResultAt: "检测于 {time}",
			probeResultEmpty: "当前没有可检测的模型。"
		};
		//#endregion
		//#region src/client/index.tsx
		/** Stable browser-plugin name; distinct from the host plugin so both can coexist. */
		const name = "dsh-raccoon-connect-client";
		/**
		* Client services this contribution needs.
		*
		* `slots` is the renderer's registration API, `locale` the dictionary
		* registry, and the entry's composer control resolves the active session's
		* model directory through `remote.session` — declaring it is required by the
		* Desktop renderer; without it Cordis rejects `directoryFor()` before this
		* bundle can finish registering its contributions.
		*/
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.session"
		];
		/**
		* Register card copy, the per-variant status cards, and the composer control.
		*
		* The entire body is wrapped so that a DSH slot-API breaking change (for
		* example the rc.6→rc.7 `id`→`key` / `order`→`priority` rename) degrades to
		* a `console.error` instead of throwing into the DSH loader and raising the
		* red "Failed to load plugins" banner. The host provider keeps working: the
		* `raccoon` model channel is unaffected, and the status route still reports
		* host health to anything that reads it.
		*/
		function apply(ctx) {
			try {
				const namespace = "settings.raccoon";
				ctx.effect(() => ctx.locale.register(namespace, {
					zh,
					en
				}), "dsh-raccoon-connect: settings copy");
				const t = ctx.locale.bind(namespace);
				const SETTINGS_TAB_SLOT = "settings.plugins.tab";
				for (const [index, variant] of CARD_VARIANTS.entries()) {
					const register = ctx.slots.register;
					ctx.slots.inject(SETTINGS_TAB_SLOT, () => register({
						name: SETTINGS_TAB_SLOT,
						key: variant.id,
						priority: 30 - index,
						inject: () => ({
							t,
							variant
						})
					}, RaccoonPluginCard));
				}
				ctx.inject(["modelDirectories"], (scope) => {
					scope.slots.inject("conversation.input.right", () => scope.slots.register({
						name: "conversation.input.right",
						id: "raccoon-probe",
						order: 10,
						inject: (sessionId) => ({
							directory: scope.modelDirectories.directoryFor(sessionId).store,
							t
						})
					}, RaccoonProbeControl));
				});
			} catch (error) {
				console.error("[dsh-raccoon-connect] client card failed to load (host provider unaffected):", error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
