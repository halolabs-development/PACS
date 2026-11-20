/*
 * 개인 검색 모음과 기관 공유 검색. 두 모음을 함께 잠그는 쓰기는 언제나 개인 → 기관 순서다.
 * PacsService가 만들어 소유하는 평범한 객체다(Nest provider가 아니다). 생성자는 참조만 저장한다.
 */
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma.service';
import { folderAction, folderEntries, folderPath, shortcutEntries } from '../filter-folders';
import { copySearchFolder, mergeCopiedFolders, sharedKeys, sharedLibrary, sharedSearch } from '../shared-filters';
import { parse, dump } from './values';
import { need, inst } from './access';
import { accountOwner, newDraftAuthor } from '../owner-identity';
import type { Caller } from './access';

export class PacsFilters {
  constructor(
    private readonly prisma: PrismaService) {}

  /** 필터 저장 (같은 이름이면 덮어쓴다 — 이름이 곧 사용자에게는 그 필터다) */
  async saveFilter(body: any, c: Caller) {
    const name = String(body.name ?? '').trim();
    if (!name) throw new BadRequestException('필터 이름이 필요합니다');

    // Old clients omit these fields; undefined must preserve existing metadata.
    let folder: string | undefined;
    if (body.folder !== undefined) folder = folderPath(body.folder, true);
    if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 1000))
      throw new BadRequestException('검색 설명은 1000자 이내로 입력하세요');
    if (body.ordinal !== undefined && (!Number.isInteger(body.ordinal) || body.ordinal < 0 || body.ordinal > 9999))
      throw new BadRequestException('표시 순서는 0~9999의 정수로 입력하세요');
    const data = {
      folder, description: body.description, ordinal: body.ordinal,
      mode: body.mode ?? 'Radiology',
      quick: String(body.quick ?? ''),
      days: Number.isFinite(+body.days) ? +body.days : -1,
      cols: dump(body.cols ?? {}) ?? '{}',
      sortKey: body.sortKey ?? null,
      sortDir: +body.sortDir || 0,
      isDefault: !!body.isDefault,
    };

    const ownerSub = accountOwner(c);
    const saved = await this.prisma.$transaction(async tx => {
      const owner = await this.selectedCollection(tx, ownerSub, body.collection);
      await this.lockFilterCollection(tx, owner, ownerSub);
      if (data.isDefault) await this.clearDefaults(tx, ownerSub);
      if (body.createOnly === true) {
        try { return await tx.userFilter.create({ data: { owner, ownerSub, name, ...data } }); }
        catch (error) {
          if ((error as any)?.code === 'P2002') throw new ConflictException('같은 이름의 검색이 있습니다. 다른 이름으로 저장하세요. 기존 검색은 변경하지 않았습니다.');
          throw error;
        }
      }
      return tx.userFilter.upsert({
        where: { owner_name: { owner, name }, ownerSub },
        create: { owner, ownerSub, name, ...data }, update: data,
      });
    });
    return { ...saved, cols: parse(saved.cols) ?? {} };
  }

  /** 기본 필터 지정/해제 */
  async setDefaultFilter(id: number, on: boolean, c: Caller) {
    const ownerSub = accountOwner(c);
    await this.prisma.$transaction(async tx => {
      const f = await tx.userFilter.findFirst({ where: { id, ownerSub } });
      if (!f) throw new NotFoundException('필터를 찾을 수 없습니다');
      await this.lockFilterCollection(tx, f.owner, ownerSub);
      if (on) await this.clearDefaults(tx, ownerSub);
      await tx.userFilter.update({ where: { id, ownerSub }, data: { isDefault: on } });
    });
    return { ok: true };
  }

  async deleteFilter(id: number, c: Caller) {
    // 남의 것을 지우지 못하게 owner를 조건에 넣는다. 찾아서 검사하고 지우면
    // 그 사이가 벌어질 수 있으므로 조건을 삭제문 안에 둔다.
    await this.prisma.$transaction(async tx => {
      const ownerSub = accountOwner(c);
      const f = await tx.userFilter.findFirst({ where: { id, ownerSub } });
      if (!f) throw new NotFoundException('필터를 찾을 수 없습니다');
      await this.lockFilterCollection(tx, f.owner, ownerSub);
      const r = await tx.userFilter.deleteMany({ where: { id, ownerSub } });
      if (!r.count) throw new NotFoundException('필터를 찾을 수 없습니다');
    });
    return { ok: true };
  }

  private async clearDefaults(tx: Prisma.TransactionClient, ownerSub: string) {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${ownerSub}::text, 7))`;
    await tx.userFilter.updateMany({ where: { ownerSub, isDefault: true }, data: { isDefault: false } });
  }

  private async collectionKeys(tx: Prisma.TransactionClient, ownerSub: string) {
    const [collections, filters] = await Promise.all([
      tx.userFilterCollection.findMany({ where: { ownerSub }, select: { owner: true } }),
      tx.userFilter.findMany({ where: { ownerSub }, distinct: ['owner'], select: { owner: true } }),
    ]);
    const keys = [...new Set([...collections, ...filters].map(row => row.owner))].sort();
    // A fresh account cannot collide with a legacy key, even one that looks like a subject.
    return keys.length ? keys : [await newDraftAuthor(tx, ownerSub)];
  }

  private async selectedCollection(tx: Prisma.TransactionClient, sub: string, selected: unknown) {
    const keys = await this.collectionKeys(tx, sub);
    if (selected === undefined && keys.length === 1) return keys[0];
    if (typeof selected === 'string' && keys.includes(selected)) return selected;
    throw new ConflictException('저장 검색 모음을 선택한 뒤 다시 시도하세요');
  }

  private async lockFilterCollection(tx: Prisma.TransactionClient, owner: string, ownerSub: string, increment = 1) {
    // A single PostgreSQL upsert locks this owner's row until the transaction ends.
    const collection = await tx.userFilterCollection.upsert({
      where: { owner }, create: { owner, ownerSub, revision: increment, folders: [] },
      update: { revision: { increment } },
    });
    if (collection.ownerSub !== ownerSub) throw new ConflictException('검색 모음의 소유 계정을 확인할 수 없습니다');
    return collection;
  }

  private filterCollectionOwner(c: Caller) {
    if (c.kind !== 'member' || !c.sub || !c.actor) throw new ForbiddenException('개인 계정으로 로그인하세요');
    return [inst(c), c.sub];
  }

  private async filterCollectionSnapshot(tx: Prisma.TransactionClient, c: Caller) {
    const ownerSub = accountOwner(c);
    const owner = this.filterCollectionOwner(c);
    const collections = await tx.userFilterCollection.findMany({ where: { ownerSub } });
    const filters = await tx.userFilter.findMany({ where: { ownerSub }, orderBy: { id: 'asc' } });
    const keys = [...new Set([...collections, ...filters].map(row => row.owner))].sort();
    const snapshot = (key?: string) => {
      const row = collections.find(r => r.owner === key);
      return { owner, revision: row?.revision ?? 0, folders: folderEntries(row?.folders ?? []),
        shortcuts: shortcutEntries(row?.shortcuts ?? []),
        filters: filters.filter(f => f.owner === key).map(f => ({ ...f, cols: parse(f.cols) ?? {} })) };
    };
    if (keys.length < 2) return snapshot(keys[0]);
    // Each editor retains its own revision, folder paths, shortcut IDs and name namespace.
    const groups = keys.map(key => ({ ...snapshot(key), collection: key }));
    return { ...groups[0], collections: groups };
  }

  async readFilterFolders(c: Caller) {
    this.filterCollectionOwner(c);
    return this.prisma.$transaction(tx => this.filterCollectionSnapshot(tx, c),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async writeFilterFolders(body: any, c: Caller) {
    const owner = this.filterCollectionOwner(c);
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).filter(k => k !== 'collection').sort().join(',') !== 'command,expectedOwner,revision' ||
        !Number.isInteger(body.revision) || body.revision < 0 || body.revision >= 2147483647)
      throw new BadRequestException('검색 모음 요청 형식을 확인하세요');
    if (JSON.stringify(body.expectedOwner) !== JSON.stringify(owner))
      throw new ConflictException('계정이 변경되었습니다. 다시 로그인하세요');
    return this.prisma.$transaction(async tx => {
      const ownerSub = accountOwner(c);
      const key = await this.selectedCollection(tx, ownerSub, body.collection);
      const collection = await this.lockFilterCollection(tx, key, ownerSub);
      if (collection.revision !== body.revision + 1)
        throw new ConflictException('다른 화면에서 검색 모음이 변경되었습니다. 편집 내용을 확인한 뒤 다시 불러오세요');
      if (body.command?.action === 'replace-shortcuts') {
        if (Object.keys(body.command).sort().join(',') !== 'action,shortcuts')
          throw new BadRequestException('바로가기 교체 요청 형식을 확인하세요');
        const shortcuts = shortcutEntries(body.command.shortcuts);
        await tx.userFilterCollection.update({ where: { owner: key, ownerSub }, data: { shortcuts } });
        return this.filterCollectionSnapshot(tx, c);
      }
      const searches = await tx.userFilter.findMany({ where: { owner: key, ownerSub }, select: { id: true, folder: true } });
      const result = folderAction(collection.folders, searches, body.command);
      for (const move of result.moves) {
        const changed = await tx.userFilter.updateMany({ where: { id: move.id, owner: key, ownerSub }, data: { folder: move.folder } });
        if (changed.count !== 1) throw new ConflictException('선택한 검색이 변경되었습니다');
      }
      if (result.deletes.length) {
        const changed = await tx.userFilter.deleteMany({ where: { owner: key, ownerSub, id: { in: result.deletes } } });
        if (changed.count !== result.deletes.length) throw new ConflictException('선택한 검색이 변경되었습니다');
      }
      await tx.userFilterCollection.update({ where: { owner: key, ownerSub }, data: { folders: result.folders } });
      return this.filterCollectionSnapshot(tx, c);
    });
  }

  private lockSharedFilters(tx: Prisma.TransactionClient, c: Caller, increment: number) {
    return tx.sharedFilterLibrary.upsert({
      where: { institution: inst(c) },
      create: { institution: inst(c), revision: increment, folders: [], filters: [], updatedBy: increment ? c.actor : '' },
      update: { revision: { increment }, ...(increment ? { updatedBy: c.actor, updatedAt: new Date() } : {}) },
    });
  }

  private sharedFilterSnapshot(row: any, c: Caller) {
    return { owner: this.filterCollectionOwner(c), revision: row?.revision ?? 0,
      canManage: c.roles.includes('admin'), updatedBy: row?.updatedBy || '', updatedAt: row?.updatedAt || null,
      ...sharedLibrary(row?.folders ?? [], row?.filters ?? []) };
  }

  async readSharedFilters(c: Caller) {
    this.filterCollectionOwner(c);
    return this.sharedFilterSnapshot(await this.prisma.sharedFilterLibrary.findUnique({ where: { institution: inst(c) } }), c);
  }

  private sharedFilterRequest(body: any, c: Caller, fields: string) {
    const owner = this.filterCollectionOwner(c);
    const allowed = body?.collection === undefined ? fields : ['collection', ...fields.split(',')].sort().join(',');
    if (!sharedKeys(body, allowed) || !Number.isInteger(body.revision) || body.revision < 0 || body.revision >= 2147483647)
      throw new BadRequestException('기관 검색 요청 형식을 확인하세요');
    if (JSON.stringify(body.expectedOwner) !== JSON.stringify(owner)) throw new ConflictException('계정이 변경되었습니다. 다시 로그인하세요');
  }

  async writeSharedFilters(body: any, c: Caller) {
    this.sharedFilterRequest(body, c, 'command,expectedOwner,revision');
    need(c.roles, 'admin', '기관 검색 배포');
    const publish = body.command?.action === 'publish-folder';
    if (publish && (!sharedKeys(body.command, 'action,from,namePrefix,replace,sourceRevision,to') ||
        !Number.isInteger(body.command.sourceRevision) || body.command.sourceRevision < 0 ||
        typeof body.command.replace !== 'boolean')) throw new BadRequestException('폴더 배포 요청 형식을 확인하세요');
    return this.prisma.$transaction(async tx => {
      // Every operation needing both locks uses personal -> institution order.
      const ownerSub = accountOwner(c);
      const key = publish ? await this.selectedCollection(tx, ownerSub, body.collection) : null;
      const personal = publish ? await this.lockFilterCollection(tx, key, ownerSub, 0) : null;
      if (publish && personal.revision !== body.command.sourceRevision)
        throw new ConflictException('개인 검색이 변경되었습니다. 개인 폴더를 다시 불러오세요');
      const row = await this.lockSharedFilters(tx, c, 1);
      if (row.revision !== body.revision + 1) throw new ConflictException('기관 검색이 변경되었습니다. 공유 목록을 다시 불러오세요');
      let library = sharedLibrary(row.folders, row.filters);
      if (publish) {
        const from = folderPath(body.command.from, true);
        const owned = await tx.userFilter.findMany({ where: { owner: key, ownerSub } });
        const sources = owned.filter(filter => !from || filter.folder === from || filter.folder.startsWith(from + '/'))
          .map(filter => sharedSearch(filter, filter.id));
        const copied = copySearchFolder(folderEntries(personal.folders), sources, from, body.command.to, body.command.namePrefix);
        const folders = mergeCopiedFolders(library.folders, library.filters, copied.folders, body.command.replace);
        const filters = new Map(library.filters.map(filter => [filter.name, filter]));
        let nextId = row.revision * 201;
        for (const copy of copied.filters) {
          const existing = filters.get(copy.name);
          if (existing && !body.command.replace) throw new ConflictException('같은 이름의 기관 검색이 있습니다. 이름 접두사 또는 명시적 교체를 사용하세요');
          filters.set(copy.name, { ...copy, id: existing?.id ?? ++nextId });
        }
        library = sharedLibrary(folders, [...filters.values()]);
      } else {
        const changes = folderAction(library.folders, library.filters, body.command);
        const moves = new Map(changes.moves.map(move => [move.id, move.folder]));
        const deleted = new Set(changes.deletes);
        library = sharedLibrary(changes.folders, library.filters.filter(filter => !deleted.has(filter.id))
          .map(filter => moves.has(filter.id) ? { ...filter, folder: moves.get(filter.id) } : filter));
      }
      const saved = await tx.sharedFilterLibrary.update({ where: { institution: inst(c) }, data: library });
      return this.sharedFilterSnapshot(saved, c);
    });
  }

  async copySharedFilters(body: any, c: Caller) {
    this.sharedFilterRequest(body, c, 'expectedOwner,from,namePrefix,personalRevision,revision,to');
    if (!Number.isInteger(body.personalRevision) || body.personalRevision < 0 || body.personalRevision >= 2147483647)
      throw new BadRequestException('개인 검색 버전을 확인하세요');
    return this.prisma.$transaction(async tx => {
      const ownerSub = accountOwner(c);
      const key = await this.selectedCollection(tx, ownerSub, body.collection);
      const personal = await this.lockFilterCollection(tx, key, ownerSub);
      if (personal.revision !== body.personalRevision + 1) throw new ConflictException('개인 검색이 변경되었습니다. 개인 폴더를 다시 불러오세요');
      const row = await this.lockSharedFilters(tx, c, 0);
      if (row.revision !== body.revision) throw new ConflictException('기관 검색이 변경되었습니다. 공유 목록을 다시 불러오세요');
      const library = sharedLibrary(row.folders, row.filters);
      if (row.revision === 0 && !library.folders.length && !library.filters.length)
        throw new NotFoundException('배포된 기관 검색이 없습니다');
      const copied = copySearchFolder(library.folders, library.filters, body.from, body.to, body.namePrefix);
      const owned = await tx.userFilter.findMany({ where: { owner: key, ownerSub } });
      const folders = mergeCopiedFolders(folderEntries(personal.folders), owned, copied.folders, false);
      const names = new Set(owned.map(filter => filter.name));
      if (copied.filters.some(filter => names.has(filter.name))) throw new ConflictException('같은 이름의 개인 검색이 있습니다. 이름 접두사를 입력하세요');
      for (const filter of copied.filters) {
        const { id, cols, ...definition } = filter;
        await tx.userFilter.create({ data: { ...definition, owner: key, ownerSub, cols: JSON.stringify(cols), isDefault: false } });
      }
      await tx.userFilterCollection.update({ where: { owner: key, ownerSub }, data: { folders } });
      return this.filterCollectionSnapshot(tx, c);
    });
  }
}
