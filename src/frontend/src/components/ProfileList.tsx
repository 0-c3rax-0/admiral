import { Check, Plus, Play, Square } from 'lucide-react'
import type { Profile } from '@/types'

type ProfileRuntimeStatus = {
  connected: boolean
  running: boolean
}

interface Props {
  profiles: Profile[]
  activeId: string | null
  statuses: Record<string, ProfileRuntimeStatus>
  playerDataMap: Record<string, Record<string, unknown>>
  onSelect: (id: string) => void
  onNew: () => void
}

async function batchAction(action: 'connect_llm' | 'disconnect') {
  try {
    await fetch('/api/profiles/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
  } catch { /* ignore */ }
}
export function ProfileList({ profiles, activeId, statuses, playerDataMap, onSelect, onNew }: Props) {
  return (
    <div className="w-56 flex flex-col flex-1 min-h-0">
      <div className="px-3.5 py-2.5 border-b border-border flex items-center justify-between">
        <h2 className="text-[11px] text-muted-foreground uppercase tracking-[1.5px] font-normal">Profiles</h2>
        <div className="flex items-center gap-1">
          <button
            onClick={() => batchAction('connect_llm')}
            className="flex items-center justify-center w-5 h-5 text-muted-foreground/50 hover:text-[hsl(var(--smui-green))] transition-colors"
            title="Connect all agents"
          >
            <Play size={10} />
          </button>
          <button
            onClick={() => batchAction('disconnect')}
            className="flex items-center justify-center w-5 h-5 text-muted-foreground/50 hover:text-[hsl(var(--smui-orange))] transition-colors"
            title="Disconnect all agents"
          >
            <Square size={10} />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {profiles.map(p => {
          const status = statuses[p.id]
          const isActive = p.id === activeId

          const pd = playerDataMap[p.id]
          const player = pd?.player as Record<string, unknown> | undefined
          const connectState = !status
            ? 'unknown'
            : status.connected
              ? 'online'
              : 'disconnected'
          const credits = typeof player?.credits === 'number'
            ? Number(player.credits).toLocaleString()
            : null
          const badgeClass =
            connectState === 'online'
              ? 'border-[hsl(var(--smui-green))]/50 bg-[hsl(var(--smui-green))]/10 text-[hsl(var(--smui-green))]'
              : connectState === 'unknown'
                ? 'border-[hsl(var(--smui-yellow))]/50 bg-[hsl(var(--smui-yellow))]/10 text-[hsl(var(--smui-yellow))]'
                : 'border-[hsl(var(--smui-red))]/50 bg-[hsl(var(--smui-red))]/10 text-[hsl(var(--smui-red))]'
          const statusLabel =
            connectState === 'online'
              ? 'Online'
              : connectState === 'unknown'
                ? 'Unknown'
                : 'Disconnected'
          const statusLabelClass =
            connectState === 'online'
              ? 'text-[hsl(var(--smui-green))]'
              : connectState === 'unknown'
                ? 'text-[hsl(var(--smui-yellow))]'
                : 'text-[hsl(var(--smui-red))]'

          return (
            <button
              key={p.id}
              onClick={() => onSelect(p.id)}
              className={`w-full text-left px-3.5 py-2 border-l-2 border-b border-border/50 transition-colors ${
                isActive
                  ? 'bg-primary/10 border-l-primary'
                  : 'border-l-transparent hover:bg-secondary/30'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={`flex h-4 w-4 items-center justify-center rounded-sm border ${badgeClass}`}
                  title={`Connect status: ${statusLabel}`}
                >
                  <Check size={11} strokeWidth={3} />
                </span>
                <span className="text-sm font-medium text-foreground truncate">{p.name}</span>
              </div>
              <div className="mt-0.5 ml-6 flex items-center gap-2 text-[10px] leading-relaxed">
                <span className="text-[hsl(var(--smui-yellow))] tabular-nums">{credits ? `${credits}c` : '0c'}</span>
                <span className={statusLabelClass}>
                  {statusLabel}
                </span>
              </div>
            </button>
          )
        })}
      </div>

      <div className="px-3.5 py-2">
        <button
          onClick={onNew}
          className="flex items-center justify-center w-full py-1.5 text-muted-foreground hover:text-primary border border-dashed border-border hover:border-primary/40 transition-colors"
        >
          <Plus size={14} />
        </button>
      </div>
    </div>
  )
}
