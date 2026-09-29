import { labelFields, stripMeta } from './node-fields.util';

describe('поля узла', () => {
  it('подпись сохраняет только присланные поля', () => {
    expect(labelFields({ text: 'Row A\nExit', fontSize: 24, labelStyle: 'badge' })).toEqual({
      text: 'Row A\nExit',
      fontSize: 24,
      labelStyle: 'badge',
    });
    expect(labelFields({ objectType: 'add_chair' })).toEqual({});
  });

  it('копия без служебных полей', () => {
    expect(stripMeta({ _id: 1, id: 2, __v: 0, createdAt: 1, updatedAt: 1, title: 'A' })).toEqual({ title: 'A' });
  });
});
