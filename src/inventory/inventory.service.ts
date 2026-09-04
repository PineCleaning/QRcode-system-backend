import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInventoryItemDto } from './dto/create-inventory-item.dto';
import { UpdateInventoryItemDto } from './dto/update-inventory-item.dto';

/** Confirmed with the user 2026-08-29 ("Q3"): keep only the 10 most recent history rows per item. */
const MAX_HISTORY_ROWS = 10;

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async findAllForSite(siteId: string) {
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) {
      throw new NotFoundException(`Site ${siteId} not found`);
    }
    return this.prisma.inventoryItem.findMany({
      where: { siteId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const item = await this.prisma.inventoryItem.findUnique({ where: { id } });
    if (!item) {
      throw new NotFoundException(`Inventory item ${id} not found`);
    }
    return item;
  }

  async findHistory(id: string) {
    await this.findOne(id);
    return this.prisma.inventoryHistory.findMany({
      where: { inventoryItemId: id },
      orderBy: { changedAt: 'desc' },
    });
  }

  async create(siteId: string, dto: CreateInventoryItemDto, adminId: string) {
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) {
      throw new NotFoundException(`Site ${siteId} not found`);
    }
    return this.prisma.inventoryItem.create({
      data: {
        siteId,
        item: dto.item,
        category: dto.category,
        status: dto.status,
        quantity: dto.quantity,
        lastSupplyDate: dto.lastSupplyDate ? new Date(dto.lastSupplyDate) : undefined,
        notes: dto.notes,
        createdBy: adminId,
        updatedBy: adminId,
      },
    });
  }

  /**
   * Snapshots the item's PRE-update quantity/status/notes into
   * inventory_history before applying the update, then prunes that
   * item's history down to the 10 most recent rows. Snapshotting and
   * pruning happen in one transaction with the update itself so a
   * failure partway through can't leave history out of sync with the
   * real update.
   */
  async update(id: string, dto: UpdateInventoryItemDto, adminId: string) {
    const existing = await this.findOne(id);

    return this.prisma.$transaction(async (tx) => {
      await tx.inventoryHistory.create({
        data: {
          inventoryItemId: id,
          previousQuantity: existing.quantity,
          previousStatus: existing.status,
          previousNotes: existing.notes,
          changedBy: adminId,
        },
      });

      const excessRows = await tx.inventoryHistory.findMany({
        where: { inventoryItemId: id },
        orderBy: { changedAt: 'desc' },
        skip: MAX_HISTORY_ROWS,
        select: { id: true },
      });
      if (excessRows.length > 0) {
        await tx.inventoryHistory.deleteMany({ where: { id: { in: excessRows.map((r) => r.id) } } });
      }

      return tx.inventoryItem.update({
        where: { id },
        data: {
          item: dto.item,
          category: dto.category,
          status: dto.status,
          quantity: dto.quantity,
          lastSupplyDate: dto.lastSupplyDate ? new Date(dto.lastSupplyDate) : undefined,
          notes: dto.notes,
          updatedBy: adminId,
        },
      });
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.inventoryItem.delete({ where: { id } });
  }
}
