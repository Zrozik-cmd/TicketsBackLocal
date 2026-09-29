import { categoryTitle, normalizePlanCategories } from './plan-categories.util';
import { zoneTitle } from './zone-titles.util';

describe('plan categories', () => {
  it('normalizes: trims, drops duplicate ids, empty name becomes null, color lower-case', () => {
    expect(
      normalizePlanCategories([
        { id: 'economy_class', name: '  ', color: '#3E7BB8' },
        { id: 'cat_fan', name: '  Fan zone ', color: '#F59A0B' },
        { id: 'cat_fan', name: 'dup', color: '#000000' },
        { id: '', name: 'no id', color: '#000000' },
      ]),
    ).toEqual([
      { id: 'economy_class', name: null, color: '#3e7bb8' },
      { id: 'cat_fan', name: 'Fan zone', color: '#f59a0b' },
    ]);
    expect(normalizePlanCategories(null)).toEqual([]);
  });

  it('titles: own name on every language, built-in translation otherwise, unknown as economy', () => {
    const categories = [
      { id: 'cat_fan', name: 'Fan zone', color: '#f59a0b' },
      { id: 'vip_class', name: 'Diamond', color: '#e0185f' },
      { id: 'business_class', name: null, color: '#b13187' },
    ];
    expect(categoryTitle('cat_fan', categories)).toEqual({ th: 'Fan zone', en: 'Fan zone', ru: 'Fan zone' });
    expect(categoryTitle('vip_class', categories).ru).toBe('Diamond');
    expect(categoryTitle('business_class', categories).ru).toBe('Бизнес класс');
    expect(categoryTitle('cat_gone', categories).en).toBe('Economy class');
    expect(categoryTitle('vip_class', undefined).en).toBe('VIP');
  });

  it('zone title uses the given category title', () => {
    const fan = categoryTitle('cat_fan', [{ id: 'cat_fan', name: 'Fan zone', color: '#f59a0b' }]);
    expect(zoneTitle({ source: 'rows', price: 1500, seatsCount: 10 }, fan, true).en).toBe('Fan zone · 1500 THB');
    expect(zoneTitle({ source: 'add_sofa', price: 900, seatsCount: 2 }, fan, false).ru).toBe('Диван · Fan zone');
    expect(zoneTitle({ source: 'numbered_table', price: 900, seatsCount: 4, objectId: 7, tableNumber: 3 }, fan, false).en)
      .toBe('Table 3 (4 seats) · Fan zone');
  });
});
