import { CanonicalCategory } from './classificationModel'

export const Category = {
  Food: 'Alimentación',
  Health: 'Salud',
  Education: 'Educación',
  Housing: 'Vivienda',
  Clothing: 'Vestimenta',
  Tourism: 'Turismo',
  Other: 'Otros',
  Uncategorized: 'Sin clasificar',
} as const

export const UNCATEGORIZED = Category.Uncategorized

export const categories = [
  Category.Food,
  Category.Health,
  Category.Education,
  Category.Housing,
  Category.Clothing,
  Category.Tourism,
  Category.Other,
  UNCATEGORIZED,
] as const

export type Category = (typeof categories)[number]

export function isCategory(value: string): value is Category {
  return categories.some((category) => category === value)
}

const canonicalLabels: Record<
  Exclude<Category, typeof UNCATEGORIZED>,
  CanonicalCategory
> = {
  [Category.Food]: CanonicalCategory.Food,
  [Category.Health]: CanonicalCategory.Health,
  [Category.Education]: CanonicalCategory.EducationArtsCulture,
  [Category.Housing]: CanonicalCategory.Housing,
  [Category.Clothing]: CanonicalCategory.Clothing,
  [Category.Tourism]: CanonicalCategory.NationalTourism,
  [Category.Other]: CanonicalCategory.Other,
}

export function categoryToCanonical(
  category: Category,
): CanonicalCategory | null {
  return category === UNCATEGORIZED ? null : canonicalLabels[category]
}

export function canonicalToCategory(
  category: CanonicalCategory | null,
): Category {
  if (category === null) {
    return UNCATEGORIZED
  }

  if (category === CanonicalCategory.EducationArtsCulture) {
    return Category.Education
  }

  if (category === CanonicalCategory.NationalTourism) {
    return Category.Tourism
  }

  return category
}
