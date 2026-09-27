"use client";

import { useContext } from "react";
import { PortalContext } from "@/components/providers/portal-provider";
import type { Role } from "@/types/party";

export function usePortal() {
  const ctx = useContext(PortalContext);
  if (!ctx) throw new Error("usePortal must be used within <PortalProvider>");
  return ctx;
}

export const isStaff = (role: Role) => role === "leader" || role === "admin";
