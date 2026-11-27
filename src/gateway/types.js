// Passerelle « API Anthropic Messages » pour Claude Code : types partagés (JSDoc seulement).
// Ce fichier fixe le contrat entre les modules de src/gateway/ (spécification § 2.0). Il n'a aucun effet à l'exécution,
// sauf la liste KINDS, source unique des sortes de requêtes reconnues par classify.js.

/**
 * Sortes de requêtes envoyées par Claude Code (§ 3.1).
 * - main, subagent : moteur complet (un chat France Student) ;
 * - web_search : chat annexe si --fs-web, sinon réponse locale ;
 * - hook_check : vérificateur d'un crochet « prompt » (/goal) → conversation de vérification sur France Student (une par session et condition) ;
 * - toutes les autres : réponse locale (background.js), 0 appel France Student.
 * @typedef {'main'|'subagent'|'title'|'name'|'probe'|'suggestion'|'compact'|'away_summary'|'agent_summary'|'tool_summary'|'bash_prefix'|'web_search'|'web_fetch'|'side_question'|'hook_check'|'background_other'} Kind
 */

/** @type {readonly Kind[]} */
export const KINDS = Object.freeze([
  'main', 'subagent',
  'title', 'name', 'probe', 'suggestion', 'compact',
  'away_summary', 'agent_summary', 'tool_summary', 'bash_prefix',
  'web_search', 'web_fetch', 'side_question', 'hook_check', 'background_other',
]);

/**
 * Environnement de la session Claude Code, lu dans son prompt système (context.extractEnv, § 3.2).
 * @typedef {{cwd:string, platform:'win32'|'darwin'|'linux', shell:string, osVersion:string, isGit:boolean, branch:string|null, extraDirs:string[], pathMod:'win32'|'posix'}} Env
 */

/**
 * Résultat de classify.classify(body, headers).
 * @typedef {{kind:Kind, sessionId:string|null, agentId:string|null, model:string, stream:boolean}} Classification
 */

/**
 * CLAUDE.md du projet retenu par context.cleanUserContent (types « project instructions » et « user's private project
 * instructions » seulement ; jamais l'auto-mémoire ni les instructions globales). Non défini dans la spécification :
 * forme fixée ici. text = contenu brut concaténé (le préambule en garde au plus 6 000 caractères, lignes filtrées),
 * hash = empreinte stable (sha1 hex de text) comparée à Conv.claudeMdHash, paths = fichiers d'origine.
 * @typedef {{text:string, hash:string, paths:string[]}} ClaudeMd
 */

/**
 * Message utilisateur canonique (transcript.canonicalize).
 * @typedef {{role:'user', text:string, results:{id:string,content:any,is_error:boolean}[], images:{media_type:string,data:string}[], notes:string[], interrupted:boolean, marker:string|null, isContinuation:boolean, claudeMd:ClaudeMd|null}} UserTurn
 */

/**
 * Message assistant canonique (transcript.canonicalize).
 * @typedef {{role:'assistant', text:string, toolUses:{id:string,name:string,input:object}[]}} AssistantTurn
 */

/**
 * Ce qu'il faut envoyer à France Student pour une requête (transcript.computeDelta, § 3.3).
 * @typedef {{kind:'replay'|'join'|'new'|'append'|'post_compact'|'rewind'|'unknown', userTurns:UserTurn[], foreignAssistantText?:string, anchorIndex?:number}} Delta
 */

/**
 * Agent (modèle) France Student résolu par models.js (§ 3.10).
 * @typedef {{agentId:number, model:string, name:string, provider:string, native:boolean, contextWindow:number}} Agent
 */

/**
 * Appel d'outil France Student en attente de résultat (§ 3.5, 3.6).
 * ccId = id du tool_use émis vers Claude Code (null si traité localement), local = résultat calculé par la passerelle.
 * @typedef {{callId:string, ccId:string|null, fsName:string, path:string|null, local:{output:string,isError:boolean}|null, retried:number}} Pending
 */

/**
 * Corps d'un envoi à France Student, construit par outbound.buildSend (seul point de sortie, § 3.7).
 * clientTools absent (undefined) = mode texte seul.
 * @typedef {{content?:string, toolResults?:{callId:string,output:string,isError:boolean}[], files?:string[], clientTools?:string[]|undefined, agentId:number, chatId:string|null, webSearch:boolean, register?:{sid:string,role:'cc'}}} FsSend
 */

// ── Types complémentaires (déduits de la spécification et de src/api.js) ──

/**
 * Appel d'outil client tel que France Student le renvoie dans completed.message.toolCalls (client-tools.md).
 * @typedef {{callId:string, name:string, arguments:object}} FsToolCall
 */

/**
 * Document du panneau du site (api.documentsOf).
 * @typedef {{id:string|null, title:string, kind:string, content:string|null, update:boolean}} FsDocument
 */

/**
 * Résultat d'un tour France Student (api.streamChat / once, resumeStream).
 * @typedef {{text:string, usage:object|null, toolCalls:FsToolCall[], stopped:boolean, images:object[], documents:FsDocument[], sawImage:boolean, chatId:string|null}} FsResult
 */

/**
 * Rappels de flux passés à deps.stream / deps.resume, en plus des champs de FsSend.
 * Les erreurs levées portent e.accepted (true si le POST a reçu un 2xx), e.status, e.code, e.retry.
 * @typedef {{signal?:AbortSignal, onText?:(delta:string)=>void, onReasoning?:(delta:string)=>void, onChat?:(chatId:string)=>void,
 *   onEvent?:(type:string, data:object)=>void, onAccepted?:()=>void, onEventId?:(id:string)=>void, onUserMessageId?:(id:string)=>void}} StreamHandlers
 */

/**
 * État du quota de nouvelles conversations (recover.quotaState, § 3.12).
 * @typedef {{created:number, limitHit:boolean, remaining:number, resetText:string}} Quota
 */

/**
 * Dépendances injectées (réseau, disque, horloge) : les vraies en production, un faux FS en test (§ 5.1).
 * fsExists et fsStat sont synchrones (utilisés par toolmap.planToolUses, synchrone).
 * @typedef {{
 *   stream:(send:FsSend & StreamHandlers)=>Promise<FsResult>,
 *   resume:(chatId:string, lastEventId:string|null, handlers:StreamHandlers)=>Promise<FsResult>,
 *   fetchChat:(chatId:string)=>Promise<object|null>,
 *   searchChats:(query:string, limit?:number)=>Promise<object[]>,
 *   compactChat:(chatId:string)=>Promise<{status:number}>,
 *   uploadFile:(buffer:Buffer, filename:string, mime?:string)=>Promise<string>,
 *   cancelStream:(chatId:string)=>Promise<boolean>,
 *   fetchAgentsFull:()=>Promise<object[]>,
 *   createdToday:()=>number,
 *   quota:()=>Quota,
 *   fsExists:(p:string)=>boolean,
 *   fsStat:(p:string)=>({isDirectory():boolean, isFile():boolean, size:number}|null),
 *   now:()=>number
 * }} Deps
 */

/**
 * Conversation Claude Code ↔ chat France Student, persistée dans HOME_DIR/gateway/conv/<id>.json (§ 3.3).
 * @typedef {{
 *   id:string, key:string, sessions:string[], sid:string,
 *   chatId:string|null, agentId:number, provider:string, native:boolean, bare:boolean,
 *   env:Env, preambleSent:boolean, claudeMdHash:string|null,
 *   lastFp:string|null, lastText:string, anchors:Array<[string, number, string, string|null]>,
 *   fs:{state:'idle'|'pending'|'inflight'|'uncertain'|'orphan_user', pending:Pending[], lastEventId:string|null, inflightKey:string|null, partial?:object[]},
 *   readSet:{sessionId:string|null, paths:Object<string, true>},
 *   notes:string[], refusal:{stage:number, toolsSeen:boolean}, subagents:number,
 *   lastReplies:{key:string, snapshot:object, fp?:string|null}[],
 *   fsPromptTokens:number, turn:number, createdAt:number, updatedAt:number,
 *   planMode?:boolean, pendingUserMessageId?:string|null,
 *   undelivered?:{fp:string|null, text:string, partial:string}|null,   // réponse que Claude Code n'a pas reçue (Échap, client parti)
 *   borrowedBy?:string|null                                            // chat prêté à cette conversation (limite du jour)
 * }} Conv
 */

/**
 * Magasin des conversations (store.openStore).
 * @typedef {{
 *   find:(cls:Classification, turns:(UserTurn|AssistantTurn)[])=>Conv|null,
 *   create:(cls:Classification, env:Env, agent:Agent)=>Conv,
 *   save:(conv:Conv)=>void,
 *   lock:(key:string, fn:()=>Promise<any>)=>Promise<any>,
 *   acquireFlow:(onWait:()=>void)=>Promise<()=>void>,
 *   recentGatewayChat:(opts?:{exclude?:string, sessions?:string[], minIdleMs?:number, oldest?:boolean})=>Conv|null,
 *   prune:()=>void
 * }} Store
 */
