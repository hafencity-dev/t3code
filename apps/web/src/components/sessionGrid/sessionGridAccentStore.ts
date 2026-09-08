import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SessionGridAccentState {
  colors: Record<string, string>;
  setColor: (threadKey: string, color: string | null) => void;
}

// fork: personal grid colors belong to this client, scoped by environment and thread.
export const useSessionGridAccentStore = create<SessionGridAccentState>()(
  persist(
    (set) => ({
      colors: {},
      setColor: (threadKey, color) => {
        if (color !== null && !/^#[0-9a-f]{6}$/i.test(color)) return;
        set((state) => {
          const colors = { ...state.colors };
          if (color === null) delete colors[threadKey];
          else colors[threadKey] = color;
          return { colors };
        });
      },
    }),
    {
      name: "t3code:session-grid-accents",
      partialize: (state) => ({ colors: state.colors }),
    },
  ),
);
