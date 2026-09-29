import { addSectorSeatCounts, emptySeatCounts } from './seat-counts.util';
import { standingZoneLinks } from './standing-zones.util';

const sector = (over: any = {}) => ({
  id: 1,
  kind: 'sector',
  sectorType: 'seating',
  numbering: {},
  seatType: 'chair',
  ticket: { price: 100, categories: ['vip_class'] },
  ...over,
});

describe('итоги Live Review', () => {
  it('стоячий сектор идёт в byCategory всей вместимостью, без типа кресла', () => {
    const counts = addSectorSeatCounts(emptySeatCounts(), sector({ sectorType: 'standing', capacity: 300 }), [], []);
    expect(counts).toEqual({ byCategory: { vip_class: 300 }, bySeatType: {} });
  });

  it('места рядов считаются как раньше, выключенные — нет, итоги копятся', () => {
    const rows = [{ id: 10, sectorId: 1, index: 0, label: 'Row 1', seatsCount: 3 }];
    const counts = addSectorSeatCounts(emptySeatCounts(), sector(), rows, [{ rowId: 10, index: 1, disabled: true }]);
    addSectorSeatCounts(counts, sector({ id: 2, sectorType: 'standing', capacity: 5 }), [], []);
    expect(counts).toEqual({ byCategory: { vip_class: 7 }, bySeatType: { chair: 2 } });
  });
});

describe('зона стоячего сектора', () => {
  it('у стоячего — его зона, без зоны — null, сидячие и объекты не трогаются', () => {
    const nodes = [sector({ id: 1, sectorType: 'standing' }), sector({ id: 2, sectorType: 'standing' }), sector({ id: 3 })];
    const groups = [
      { sectorId: 1, standing: true, eventSectorId: 'plan-1', eventZoneId: 'plan-1-vip_class-0' },
      { sectorId: 1, standing: false, eventSectorId: 'plan-1', eventZoneId: 'plan-1-add_chair-vip_class-0' },
      { sectorId: 3, standing: false, eventSectorId: 'plan-3', eventZoneId: 'plan-3-vip_class-0' },
    ];
    expect(standingZoneLinks(nodes, groups)).toEqual([
      { id: 1, eventSectorId: 'plan-1', eventZoneId: 'plan-1-vip_class-0' },
      { id: 2, eventSectorId: null, eventZoneId: null },
    ]);
  });
});
