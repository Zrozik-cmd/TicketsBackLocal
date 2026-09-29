import { keepPlanSectors } from './plan-sectors.util';

const sector = (id: string, zoneId: string) => ({ id, color: '#fff', name: { en: id }, zones: [{ id: zoneId, name: { en: 'z' }, seats: 10, isFree: false, price: 100, currency: 'THB' }] });

describe('секторы схемы при сохранении события', () => {
  it('ручные — из формы, секторы схемы — из базы, присланные plan- отбрасываются', () => {
    const incoming = [sector('s-manual', 'z1'), sector('plan-5', 'plan-5-stale')];
    const current = [sector('s-old', 'z0'), sector('plan-5', 'plan-5-vip_class-0'), sector('plan-objects', 'plan-objects-add_chair-economy_class-0')];
    const result = keepPlanSectors(incoming, current);
    expect(result.map((s) => s.id)).toEqual(['s-manual', 'plan-5', 'plan-objects']);
    expect(result[1].zones![0].id).toBe('plan-5-vip_class-0');
  });

  it('форма без секторов схемы их не стирает', () => {
    const result = keepPlanSectors([sector('s-manual', 'z1')], [sector('plan-9', 'plan-9-x')]);
    expect(result.map((s) => s.id)).toEqual(['s-manual', 'plan-9']);
  });
});
