"use client";

import { createContext, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import {
  mockApplications,
  mockAvailability,
  mockCms,
  mockEvents,
  mockMembers,
} from "@/data/mockData";
import type {
  Application,
  AvailabilitySlot,
  CmsContent,
  Member,
  NotificationPrefs,
  PartyEvent,
  Role,
} from "@/types/party";

export interface PortalState {
  loggedIn: boolean;
  login: (method: "password" | "steam") => void;
  logout: () => void;
  role: Role;
  setRole: (r: Role) => void;
  currentUserId: string;
  members: Member[];
  setMembers: Dispatch<SetStateAction<Member[]>>;
  applications: Application[];
  setApplications: Dispatch<SetStateAction<Application[]>>;
  events: PartyEvent[];
  setEvents: Dispatch<SetStateAction<PartyEvent[]>>;
  availability: AvailabilitySlot[];
  setAvailability: Dispatch<SetStateAction<AvailabilitySlot[]>>;
  cms: CmsContent;
  setCms: (c: CmsContent) => void;
  prefs: NotificationPrefs;
  setPrefs: (p: NotificationPrefs) => void;
}

export const PortalContext = createContext<PortalState | null>(null);

export function PortalProvider({ children }: { children: ReactNode }) {
  const [loggedIn, setLoggedIn] = useState(false);
  const [role, setRole] = useState<Role>("leader");
  const [members, setMembers] = useState<Member[]>(mockMembers);
  const [applications, setApplications] = useState<Application[]>(mockApplications);
  const [events, setEvents] = useState<PartyEvent[]>(mockEvents);
  const [availability, setAvailability] = useState<AvailabilitySlot[]>(mockAvailability);
  const [cms, setCms] = useState<CmsContent>(mockCms);
  const [prefs, setPrefs] = useState<NotificationPrefs>({
    events: true,
    applications: true,
    news: false,
  });

  const currentUserId = role === "leader" ? "m1" : role === "admin" ? "m2" : "m4";

  return (
    <PortalContext.Provider
      value={{
        loggedIn,
        login: () => setLoggedIn(true),
        logout: () => setLoggedIn(false),
        role,
        setRole,
        currentUserId,
        members,
        setMembers,
        applications,
        setApplications,
        events,
        setEvents,
        availability,
        setAvailability,
        cms,
        setCms,
        prefs,
        setPrefs,
      }}
    >
      {children}
    </PortalContext.Provider>
  );
}
