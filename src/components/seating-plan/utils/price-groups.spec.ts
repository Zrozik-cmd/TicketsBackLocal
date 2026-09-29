import { buildPriceGroups, objectPlaces, resolveObjectTicket } from './price-groups.util';
import { resolveTicket, sectorSeatsTotal } from './expand.util';
import { seatsForRow } from './row-shape.util';

const sector = (over: any = {}) => ({
  id: 1,
  kind: 'sector',
  title: 'VIP',
  color: 'blue',
  sectorType: 'seating',
  numbering: {},
  ticket: { price: 3000, categories: ['business_class'], availability: 'available' },
  ...over,
});

const row = (id: number, index: number, seatsCount: number, ticket: any = null) => ({
  id,
  sectorId: 1,
  index,
  label: `Row ${index + 1}`,
  seatsCount,
  ticket,
});

const object = (over: any) => ({ kind: 'object', parentId: null, ticket: {}, ...over });

describe('цены схемы зала', () => {
  it('наследуются сектор → ряд → место, пустое значение уровня не обнуляет верхнее', () => {
    const ticket = resolveTicket(
      sector(),
      { ticket: { price: '', categories: [] } },
      { ticket: { price: null, availability: 'available' } },
    );
    expect(ticket.price).toBe(3000);
    expect(ticket.categories).toEqual(['business_class']);
  });

  it('группирует места по ряду и месту: своя цена ряда и места — отдельные зоны', () => {
    const rows = [row(10, 0, 4, { price: 5000, categories: ['vip_class'] }), row(11, 1, 4)];
    const seats = [
      { rowId: 11, index: 0, ticket: { price: 4500 } },
      { rowId: 11, index: 3, ticket: { availability: 'unavailable' } },
    ];
    const groups = buildPriceGroups([sector()], new Map([[1, rows]]), new Map([[1, seats]]));
    const summary = groups.map((group) => `${group.category}:${group.price}:${group.seatsCount}`);
    expect(summary).toEqual(['vip_class:5000:4', 'business_class:4500:1', 'business_class:3000:2']);
  });

  it('стул внутри сектора берёт его цену, диван и номерной стол — свои', () => {
    const objects = [
      object({ id: 20, objectType: 'add_chair', parentId: 1 }),
      object({ id: 21, objectType: 'add_sofa', capacity: 3, ticket: { price: 2500, categories: ['vip_class'] } }),
      object({ id: 22, objectType: 'numbered_table', tableNumber: 7, capacity: 4, ticket: { price: 1200 } }),
      object({ id: 23, objectType: 'add_chair', ticket: { availability: 'unavailable' } }),
      object({ id: 24, objectType: 'add_bar' }),
    ];
    const groups = buildPriceGroups([sector({ rowsCount: 0 })], new Map(), new Map(), objects);

    const chair = groups.find((group) => group.source === 'add_chair');
    expect(chair).toMatchObject({ sectorId: 1, price: 3000, category: 'business_class', seatsCount: 1 });

    const sofa = groups.find((group) => group.source === 'add_sofa');
    expect(sofa).toMatchObject({ sectorId: null, price: 2500, category: 'vip_class', seatsCount: 3 });
    expect(sofa?.seats.map((seat) => seat.label)).toEqual(['Sofa #21 - Seat#1', 'Sofa #21 - Seat#2', 'Sofa #21 - Seat#3']);

    const table = groups.find((group) => group.objectId === 22);
    expect(table).toMatchObject({ tableNumber: 7, price: 1200, seatsCount: 4, category: 'economy_class' });
    expect(table?.seats.map((seat) => seat.label)).toEqual([
      'Table 7 - Seat#1',
      'Table 7 - Seat#2',
      'Table 7 - Seat#3',
      'Table 7 - Seat#4',
    ]);

    // Снятый с продажи стул и бар в продажу не попадают.
    expect(groups.reduce((sum, group) => sum + group.seatsCount, 0)).toBe(8);
  });

  it('своё у объекта перекрывает сектор, не заданное берётся с сектора', () => {
    const ticket = resolveObjectTicket({ ticket: { categories: ['vip_class'] } }, sector());
    expect(ticket).toMatchObject({ price: 3000, categories: ['vip_class'], availability: 'available' });
    expect(objectPlaces({ objectType: 'numbered_table', capacity: 6 })).toBe(6);
    expect(objectPlaces({ objectType: 'add_sofa', capacity: 3 })).toBe(3);
    // Диван, сохранённый до поля «мест на диване», остаётся одним местом.
    expect(objectPlaces({ objectType: 'add_sofa', capacity: 0 })).toBe(1);
    expect(objectPlaces({ objectType: 'add_chair', capacity: 6 })).toBe(1);
  });

  it('ряды фигурного сектора короче, как на холсте конструктора', () => {
    const trapezoid = Array.from({ length: 10 }, (_, index) => seatsForRow('trapezoid', index, 10, 13));
    expect(trapezoid).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(seatsForRow('rectangle', 3, 10, 13)).toBe(13);
    expect(seatsForRow('corner', 0, 10, 10)).toBe(4);
  });

  it('стоячий сектор — одна зона на всю вместимость по цене и классу сектора', () => {
    const standing = sector({ sectorType: 'standing', rowsCount: 0, seatsPerRow: 0, capacity: 150 });
    const groups = buildPriceGroups([standing], new Map(), new Map());
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ standing: true, seatsCount: 150, price: 3000, category: 'business_class', seats: [] });
  });

  it('декор не даёт мест: ни в зонах, ни во вместимости сектора', () => {
    const objects = [
      object({ id: 20, objectType: 'add_chair', parentId: 1, decor: true }),
      object({ id: 21, objectType: 'numbered_table', capacity: 6, decor: true, ticket: { price: 900 } }),
      object({ id: 22, objectType: 'add_chair', parentId: 1 }),
    ];
    const groups = buildPriceGroups([sector({ rowsCount: 0 })], new Map(), new Map(), objects);
    expect(groups.map((group) => `${group.source}:${group.seatsCount}`)).toEqual(['add_chair:1']);
    expect(sectorSeatsTotal(sector({ rowsCount: 0 }), [], objects)).toBe(1);
  });

  it('подпись не даёт мест и не попадает в зоны, даже с ценой в ticket', () => {
    const label = object({ id: 30, objectType: 'text_label', parentId: 1, text: 'Exit', ticket: { price: 100 } });
    expect(buildPriceGroups([sector({ rowsCount: 0 })], new Map(), new Map(), [label])).toEqual([]);
    expect(sectorSeatsTotal(sector({ rowsCount: 0 }), [], [label])).toBe(0);
  });
});
