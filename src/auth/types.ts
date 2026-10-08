import type { AuthenticationState } from "@whiskeysockets/baileys";

/** One account's live auth state, as Baileys needs it, plus how to persist and (optionally) erase it. */
export type AuthStateHandle = {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  /** Deletes the stored state, for unlinking. Backends that cannot erase leave it out. */
  clear?: () => Promise<void>;
};

/** Supplies auth state for an account. Pass one to connectWhatsApp, pairWhatsApp or diagnoseWhatsApp to bring your own store. */
export type AuthStateFactory = (accountId: string) => Promise<AuthStateHandle>;
