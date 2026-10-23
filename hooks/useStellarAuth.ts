"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { isAxiosError } from "axios";
import axiosInstance from "@/lib/config/axios.config";
import { useStellar } from "@/components/stellar/StellarProvider";
import { persistSession } from "@/hooks/useAuth";
import { User } from "@/types/api";

const CHALLENGE_PATH = "/api/auth/stellar/challenge";
const VERIFY_PATH = "/api/auth/stellar/verify";

// ---------------------------------------------------------------------------
// SEP-10 payload types (#514)
// ---------------------------------------------------------------------------

/** Response payload of `GET /api/auth/stellar/challenge?account=<address>`. */
export interface StellarChallengePayload {
  transaction?: string;
  networkPassphrase?: string;
  /** snake_case alias accepted from some API versions. */
  network_passphrase?: string;
}

export interface StellarChallenge {
  transaction: string;
  networkPassphrase: string;
}

/** Successful SEP-10 verification — the backend minted a session token. */
export interface StellarVerifySuccess {
  token: string;
  user: User;
}

/** SEP-10 verification for a wallet that is not linked to a Deen Bridge account yet. */
export interface StellarVerifyUnregistered {
  registered: false;
  account?: string;
}

export type StellarVerifyResponse = StellarVerifySuccess | StellarVerifyUnregistered;

/** `loginWithStellar` resolves to the session user, or an unregistered marker. */
export interface UnregisteredWalletResult {
  unregistered: true;
  account?: string;
}

export type StellarLoginResult = User | UnregisteredWalletResult | null;

// ---------------------------------------------------------------------------
// Error helpers — caught errors arrive as `unknown` and are narrowed before use.
// ---------------------------------------------------------------------------

const getErrorMessage = (error: unknown): string => {
  if (isAxiosError(error)) {
    const data = error.response?.data as
      | { message?: string; error?: string }
      | undefined;
    return data?.message || data?.error || error.message || "";
  }
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
};

const getErrorStatus = (error: unknown): number | undefined => {
  if (isAxiosError(error)) {
    return error.response?.status;
  }
  if (typeof error === "object" && error !== null) {
    const response = (error as { response?: { status?: unknown } }).response;
    const status = response?.status;
    if (typeof status === "number") {
      return status;
    }
  }
  return undefined;
};

const isModalClosedError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: string | number; message?: string };
  return (
    code === -1 ||
    (typeof message === "string" && /closed|cancel(l)?ed|reject(ed)?/i.test(message))
  );
};

const isExpiredChallengeError = (error: unknown): boolean => {
  const message = getErrorMessage(error);
  return /expir|time.?bound|challenge.*(invalid|expired)/i.test(message);
};

const isUnregisteredWalletResponse = (
  data: unknown
): data is StellarVerifyUnregistered => {
  if (typeof data !== "object" || data === null) return false;
  const registered = (data as { registered?: unknown }).registered;
  return registered === false;
};

const isUnregisteredWallet = (error: unknown, data?: unknown): boolean => {
  if (data && typeof data === "object" && "registered" in data) {
    const registered = (data as { registered?: unknown }).registered;
    if (registered === false) return true;
  }
  const status = getErrorStatus(error);
  return status === 404 || status === 409;
};

const getNetworkPassphrase = (payload: StellarChallengePayload = {}): string =>
  payload.networkPassphrase || payload.network_passphrase || "";

const fetchChallenge = async (account: string): Promise<StellarChallenge> => {
  const res = await axiosInstance.get<StellarChallengePayload>(CHALLENGE_PATH, {
    params: { account },
  });
  const transaction = res.data?.transaction;
  const networkPassphrase = getNetworkPassphrase(res.data);

  if (!transaction || !networkPassphrase) {
    throw new Error("Invalid challenge response from server");
  }

  return { transaction, networkPassphrase };
};

const verifyChallenge = async (
  signedXdr: string
): Promise<StellarVerifyResponse> => {
  const res = await axiosInstance.post<StellarVerifyResponse>(VERIFY_PATH, {
    transaction: signedXdr,
  });
  return res.data;
};

export interface UseStellarAuthResult {
  loginWithStellar: () => Promise<StellarLoginResult>;
  isPending: boolean;
  stellarAuthAvailable: boolean | null;
  availabilityChecked: boolean;
  kitInitialized: boolean;
}

export function useStellarAuth(): UseStellarAuthResult {
  const { kitInitialized, selectWallet, signTransaction } = useStellar();
  const [isPending, setIsPending] = useState<boolean>(false);
  const [stellarAuthAvailable, setStellarAuthAvailable] = useState<boolean | null>(null);
  const [availabilityChecked, setAvailabilityChecked] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;

    const probe = async () => {
      try {
        const res = await axiosInstance.get(CHALLENGE_PATH, {
          validateStatus: () => true,
        });

        if (cancelled) return;

        if (res.status === 404 || res.status === 503) {
          setStellarAuthAvailable(false);
        } else {
          setStellarAuthAvailable(true);
        }
      } catch (error: unknown) {
        if (cancelled) return;
        const status = getErrorStatus(error);
        if (status === 404 || status === 503) {
          setStellarAuthAvailable(false);
        } else if (status) {
          setStellarAuthAvailable(true);
        } else {
          setStellarAuthAvailable(true);
        }
      } finally {
        if (!cancelled) setAvailabilityChecked(true);
      }
    };

    probe();
    return () => {
      cancelled = true;
    };
  }, []);

  const loginWithStellar = useCallback(async (): Promise<StellarLoginResult> => {
    if (!kitInitialized) {
      toast.error("Wallet kit not initialized. Please refresh the page.");
      return null;
    }

    if (stellarAuthAvailable === false) {
      toast.error(
        "Sign in with Stellar is not available yet. Please use email login."
      );
      return null;
    }

    setIsPending(true);

    try {
      const address = await selectWallet();

      const attemptVerify = async (allowRetry: boolean): Promise<StellarVerifyResponse> => {
        const { transaction, networkPassphrase } = await fetchChallenge(address);
        const signedXdr = await signTransaction(transaction, networkPassphrase);

        try {
          return await verifyChallenge(signedXdr);
        } catch (verifyError) {
          if (allowRetry && isExpiredChallengeError(verifyError)) {
            return attemptVerify(false);
          }
          throw verifyError;
        }
      };

      const data = await attemptVerify(true);

      if (isUnregisteredWalletResponse(data)) {
        toast.error(
          "This wallet is not linked to a Deen Bridge account yet. Sign up with email, then link your wallet from the dashboard."
        );
        return { unregistered: true, account: data.account || address };
      }

      const { token, user } = data;
      if (!token || !user) {
        throw new Error("Invalid verify response from server");
      }

      persistSession(token, user);
      toast.success("Signed in with Stellar");
      return user;
    } catch (error: unknown) {
      if (isModalClosedError(error)) {
        toast.message("Wallet connection cancelled");
        return null;
      }

      if (isUnregisteredWallet(error)) {
        toast.error(
          "This wallet is not linked to a Deen Bridge account yet. Sign up with email, then link your wallet from the dashboard."
        );
        return { unregistered: true };
      }

      const status = getErrorStatus(error);
      if (status === 503 || status === 404) {
        setStellarAuthAvailable(false);
        toast.error(
          "Sign in with Stellar is not available on the server yet. Please use email login."
        );
        return null;
      }

      const message = getErrorMessage(error) || "Sign in with Stellar failed. Please try again.";

      console.error("Stellar auth error:", error);
      toast.error(message);
      throw error;
    } finally {
      setIsPending(false);
    }
  }, [kitInitialized, selectWallet, signTransaction, stellarAuthAvailable]);

  return {
    loginWithStellar,
    isPending,
    stellarAuthAvailable,
    availabilityChecked,
    kitInitialized,
  };
}

export default useStellarAuth;
