/*
 * The parts (parts.ts) over a SqliteStore: each a small object whose
 * methods delegate to the SqliteStore method of the old name, looked up at
 * call time. They add nothing: the reservation, the SQL and the accounting
 * are SqliteStore's, and so is each operation's name (named explicitly
 * at its reservation, src/store/accounting.ts).
 */

import { newTerminalOutputKey } from "./rows";
import { storeExport, storeHead, storeRestore } from "./history";
import type { SqliteStore } from "./sqlite-store";
import type {
  Accounts, Admission, Credentials, History, Lifecycle, LiveText, Messages, Meter, Ops, Push, Reads, Rooms, Server, Uploads,
} from "./parts";

/** Accounts over SqliteStore. */
export function sqliteAccounts(sqlite: SqliteStore): Accounts {
  return {
    get: (userId) => sqlite.getIdentity(userId),
    exists: (userId) => sqlite.identityExists(userId),
    idTaken: (userId) => sqlite.userIdTaken(userId),
    register: (input) => sqlite.registerIdentity(input),
    createInvited: (input) => sqlite.createInvitedIdentity(input),
    ensureAdmin: (input) => sqlite.ensureAdminUser(input),
    rename: (input) => sqlite.renameIdentity(input),
    purge: (input) => sqlite.purgeUsers(input),
    noteActive: (userId, now) => sqlite.noteActive(userId, now),
    pruneIdle: (now, connected) => sqlite.pruneIdleIdentities(now, connected),
    idlePruned: (now) => sqlite.idlePruned(now),
    dueRetiredIds: (now) => sqlite.dueRetiredUserIds(now),
    freeRetiredIds: (userIds, now) => sqlite.freeRetiredUserIds(userIds, now),
    setRole: (input) => sqlite.setRole(input),
    withRole: (role, limit, now) => sqlite.usersWithRole(role, limit, now),
    registerBot: (input) => sqlite.registerBot(input),
    markBotActive: (userId, now) => sqlite.markBotActive(userId, now),
    markBotSignedOut: (userId, now) => sqlite.markBotSignedOut(userId, now),
    idleBots: (input) => sqlite.idleBots(input),
    setStatus: (input) => sqlite.readState.setStatus(input),
    setMute: (input) => sqlite.readState.setMute(input),
    clearExpiredMutes: (now) => sqlite.readState.clearExpiredMutes(now),
  };
}

/** Credentials over SqliteStore. */
export function sqliteCredentials(sqlite: SqliteStore): Credentials {
  return {
    get: (credentialId) => sqlite.getCredential(credentialId),
    add: (input) => sqlite.addCredential(input),
    ensureHandle: (userId, candidate, now) => sqlite.ensureUserHandle(userId, candidate, now),
    passkeys: (userId, now) => sqlite.passkeys(userId, now),
    removePasskey: (input) => sqlite.removePasskey(input),
    resetAuth: (input) => sqlite.resetAuth(input),
    idsForUser: (userId) => sqlite.credentialIdsForUser(userId),
    updateCounter: (credentialId, counter) => sqlite.updateCredentialCounter(credentialId, counter),
  };
}

/** Rooms over SqliteStore. */
export function sqliteRooms(sqlite: SqliteStore): Rooms {
  return {
    get: (roomId, now) => sqlite.getRoom(roomId, now),
    list: (now, options) => sqlite.listRooms(now, options),
    members: (roomIds, limit, now, counts, withStatus) => sqlite.roomMembers(roomIds, limit, now, counts, withStatus),
    member: (roomId, userId, now, withStatus) => sqlite.roomMember(roomId, userId, now, withStatus),
    creator: (roomId, now) => sqlite.roomCreator(roomId, now),
    counts: (now) => sqlite.roomCounts(now),
    privateOf: (userId, now) => sqlite.privateRoomsOf(userId, now),
    topLevelIds: (now) => sqlite.topLevelRoomIds(now),
    changeMembership: (input) => sqlite.changeMembership(input),
    chargeGuestMembership: (input) => sqlite.chargeGuestMembership(input),
    removeEmptyThread: (roomId, now) => sqlite.removeEmptyThread(roomId, now),
    memberCount: (roomId, now) => sqlite.roomMemberCount(roomId, now),
  };
}

/** Messages over SqliteStore. */
export function sqliteMessages(sqlite: SqliteStore): Messages {
  return {
    mutate: (input) => sqlite.mutate(input),
    commit: (input) => sqlite.commitMutation(input),
    author: (messageId, now) => sqlite.messageAuthor(messageId, now),
    historyAcrossTiers: (query) => sqlite.historyAcrossTiers(query),
  };
}

/** Reads over SqliteStore. */
export function sqliteReads(sqlite: SqliteStore): Reads {
  return {
    cursors: (userId, now) => sqlite.readState.readCursors(userId, now),
    saveCursors: (input) => sqlite.readState.saveReadCursors(input),
    roomCursors: (roomIds, except, now) => sqlite.readState.roomReadCursors(roomIds, except, now),
    settleSeen: (input) => sqlite.readState.settleSeen(input),
    setRoomMute: (input) => sqlite.readState.setRoomMute(input),
    expireRoomMutes: (userId, now) => sqlite.readState.expireRoomMutes(userId, now),
    presenceToggle: (now) => sqlite.readState.presenceToggle(now),
    statusInputs: (userId, now) => sqlite.readState.statusInputs(userId, now),
  };
}

/** Server over SqliteStore. */
export function sqliteServer(sqlite: SqliteStore): Server {
  return {
    metadata: (now) => sqlite.uploads.serverMetadata(now),
    setText: (field, value, now) => sqlite.uploads.setServerText(field, value, now),
    clearAvatar: (now) => sqlite.uploads.clearServerAvatar(now),
    emojiCatalog: (now) => sqlite.uploads.emojiCatalog(now),
    emojiDraft: (edit, now) => sqlite.uploads.emojiDraft(edit, now),
    commitEmoji: (draft, now) => sqlite.uploads.commitEmoji(draft, now),
    toggle: (feature, now) => sqlite.uploads.toggle(feature, now),
    setToggle: (feature, on, now, since) => sqlite.uploads.setToggle(feature, on, now, since),
    startAvatarUpload: (input) => sqlite.uploads.startServerAvatarUpload(input),
  };
}

/** Admission over SqliteStore. */
export function sqliteAdmission(sqlite: SqliteStore): Admission {
  return {
    reserveAuthAttempt: (input) => sqlite.admission.reserveAuthAttempt(input),
    reserveGuestNumbers: (count, now) => sqlite.admission.reserveGuestNumbers(count, now),
    reserveFrames: (input) => sqlite.admission.reserveFrames(input),
    reserveConnection: (input) => sqlite.admission.reserveConnection(input),
    checkConnectionBudget: (now) => sqlite.checkConnectionBudget(now),
    noteThrottleTrip: (trigger, now) => sqlite.admission.noteThrottleTrip(trigger, now),
    throttleTrips: (now) => sqlite.admission.throttleTrips(now),
    attackPause: () => sqlite.admission.attackPause(),
    setAttackPause: (value, now) => sqlite.admission.setAttackPause(value, now),
  };
}

/** Meter over SqliteStore (withMeterAsync). */
export function sqliteMeter(sqlite: SqliteStore): Meter {
  return {
    foreground: (cost, fn, now) => sqlite.withMeterAsync("foreground", cost, fn, now),
    maintenance: (cost, fn, now) => sqlite.withMeterAsync("maintenance", cost, fn, now),
  };
}

/** Ops over SqliteStore. */
export function sqliteOps(sqlite: SqliteStore): Ops {
  return {
    get config() { return sqlite.config; },
    get onOverrun() { return sqlite.onOverrun; },
    set onOverrun(hook) { sqlite.onOverrun = hook; },
    get onAccounting() { return sqlite.onAccounting; },
    set onAccounting(hook) { sqlite.onAccounting = hook; },
    get actor() { return sqlite.actor; },
    set actor(hook) { sqlite.actor = hook; },
    accountingStatus: () => sqlite.accountingStatus(),
    accountingGuard: (now) => sqlite.accountingGuard(now),
    accountUsageSnapshot: () => sqlite.accountUsageSnapshot(),
    persistAccountUsageSnapshot: (snapshot, now) => sqlite.persistAccountUsageSnapshot(snapshot, now),
    status: (now) => sqlite.status(now),
    budgetShares: (now) => sqlite.budgetShares(now),
    databaseSize: () => sqlite.databaseSize(),
    alert: (fn) => sqlite.alert(fn),
    announcedTier: (now) => sqlite.announcedTier(now),
    setAnnouncedTier: (value, now) => sqlite.setAnnouncedTier(value, now),
    storageAlerted: () => sqlite.storageAlerted(),
    setStorageAlerted: (alerted, now) => sqlite.setStorageAlerted(alerted, now),
    roomNotesAlerted: () => sqlite.roomNotesAlerted(),
    setRoomNotesAlerted: (alerted, now) => sqlite.setRoomNotesAlerted(alerted, now),
    takeRoomNotesCheck: () => sqlite.takeRoomNotesCheck(),
  };
}

/** Lifecycle over SqliteStore. */
export function sqliteLifecycle(sqlite: SqliteStore): Lifecycle {
  return {
    initialize: () => sqlite.initialize(),
    requiresReset: () => sqlite.requiresReset(),
    resetStorage: () => sqlite.resetStorage(),
    scheduleAlarm: (socketDeadline, now) => sqlite.scheduleAlarm(socketDeadline, now),
    alarmFired: () => sqlite.alarmFired(),
    takeAlarmChange: () => sqlite.takeAlarmChange(),
    cleanupDue: (now) => sqlite.cleanupDue(now),
    runCleanup: (now, options) => sqlite.runCleanup(now, options),
  };
}

/** History over SqliteStore. */
export function sqliteHistory(sqlite: SqliteStore): History {
  return {
    head: (name) => storeHead(name, sqlite),
    state: () => sqlite.historyStatePort(),
    restore: () => storeRestore(sqlite),
    export: () => storeExport(sqlite),
    hotRecords: (now) => sqlite.hotRecords(now),
    rewrites: (now) => sqlite.historyRewrites(now),
    metaNumber: (key, now) => sqlite.historyMetaNumber(key, now),
    setMeta: (key, value, now) => sqlite.setHistoryMeta(key, value, now),
    importJournal: (now) => sqlite.historyImportJournal(now),
    chunkIndex: (tier) => sqlite.chunkIndex(tier),
  };
}

/** Push over SqliteStore. */
export function sqlitePush(sqlite: SqliteStore): Push {
  return {
    register: (input) => sqlite.pushes.registerPushSubscription(input),
    remove: (input) => sqlite.pushes.removePushSubscription(input),
    joinedWakers: (now) => sqlite.pushes.joinedWakers(now),
    claim: (input) => sqlite.pushes.claimPushes(input),
    clearUnread: (userId, now) => sqlite.pushes.clearPushUnread(userId, now),
    clearSubscriptions: (userId, now) => sqlite.pushes.clearPushSubscriptions(userId, now),
    forgetSubscriptions: (gone, now) => sqlite.pushes.forgetPushSubscriptions(gone, now),
    message: (messageId, now) => sqlite.pushes.pushedMessage(messageId, now),
    sentToday: (now) => sqlite.pushes.pushesToday(now),
  };
}

/** Uploads over SqliteStore. */
export function sqliteUploads(sqlite: SqliteStore): Uploads {
  return {
    terminalOutputKey: () => newTerminalOutputKey(),
    startAvatar: (input) => sqlite.uploads.startAvatarUpload(input),
    startEmoji: (input) => sqlite.uploads.startEmojiUpload(input),
    owner: (key, now) => sqlite.uploads.uploadOwner(key, now),
    finish: (write, now) => sqlite.uploads.finishUpload(write, now),
    claim: (key, now) => sqlite.uploads.claimUpload(key, now),
    expirePending: (now) => sqlite.uploads.expirePendingUploads(now),
    nextDeadline: (now) => sqlite.uploads.nextUploadDeadline(now),
    cleanup: (now) => sqlite.uploads.cleanupUploads(now),
    avatarRefreshDue: (userId, now) => sqlite.uploads.avatarRefreshDue(userId, now),
    renewAvatar: (input) => sqlite.uploads.renewAvatar(input),
    clearAvatar: (input) => sqlite.uploads.clearAvatar(input),
  };
}

/** LiveText over SqliteStore. */
export function sqliteLiveText(sqlite: SqliteStore): LiveText {
  return {
    open: (now) => sqlite.live.openLiveTexts(now),
    start: (input) => sqlite.live.startLiveCommand(input),
    claim: (key, now) => sqlite.live.claimLiveText(key, now),
    finish: (key, kept, now, stored) => sqlite.live.finishLiveText(key, kept, now, stored),
    expire: (streaming, now) => sqlite.live.expireLiveTexts(streaming, now),
  };
}
