import type { PortSlot } from './types.js';

export class PortSlotManager {
  private basePort: number;
  private portSpan: number;
  private maxSlots: number;
  private usedSlots = new Set<number>();
  private agentSlots = new Map<string, number>();

  constructor(basePort: number = 3100, maxSlots: number = 50, portSpan: number = 100) {
    this.basePort = basePort;
    this.maxSlots = maxSlots;
    this.portSpan = portSpan;
  }

  /**
   * Allocate a slot and calculate PORT and TEST_PORT.
   * If agentId already has an allocated slot, returns that existing slot.
   */
  allocate(agentId?: string): PortSlot {
    if (agentId && this.agentSlots.has(agentId)) {
      const slot = this.agentSlots.get(agentId)!;
      return {
        slot,
        port: this.basePort + slot,
        testPort: this.basePort + this.portSpan + slot,
      };
    }

    for (let slot = 0; slot < this.maxSlots; slot++) {
      if (!this.usedSlots.has(slot)) {
        this.usedSlots.add(slot);
        if (agentId) {
          this.agentSlots.set(agentId, slot);
        }
        return {
          slot,
          port: this.basePort + slot,
          testPort: this.basePort + this.portSpan + slot,
        };
      }
    }

    // Overflow fallback
    const overflowSlot = this.maxSlots + Math.floor(Math.random() * 100);
    if (agentId) {
      this.agentSlots.set(agentId, overflowSlot);
    }
    return {
      slot: overflowSlot,
      port: this.basePort + overflowSlot,
      testPort: this.basePort + this.portSpan + overflowSlot,
    };
  }

  /**
   * Release an allocated slot either by slot number or agentId.
   */
  release(slotOrAgentId: number | string): boolean {
    let slot: number | undefined;
    if (typeof slotOrAgentId === 'string') {
      slot = this.agentSlots.get(slotOrAgentId);
      this.agentSlots.delete(slotOrAgentId);
    } else {
      slot = slotOrAgentId;
      for (const [aId, s] of this.agentSlots.entries()) {
        if (s === slot) {
          this.agentSlots.delete(aId);
          break;
        }
      }
    }

    if (slot !== undefined) {
      return this.usedSlots.delete(slot);
    }
    return false;
  }

  getSlot(agentId: string): number | undefined {
    return this.agentSlots.get(agentId);
  }

  isSlotInUse(slot: number): boolean {
    return this.usedSlots.has(slot);
  }

  clear(): void {
    this.usedSlots.clear();
    this.agentSlots.clear();
  }
}

export const portSlotManager = new PortSlotManager();
