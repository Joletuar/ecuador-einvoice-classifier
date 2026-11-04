import type { Component } from 'vue'
import { Category } from '../domain/categoryModel'
import {
  CircleHelp,
  GraduationCap,
  HeartPulse,
  House,
  PencilLine,
  Plane,
  Scale,
  Shapes,
  Shirt,
  ShoppingBasket,
} from 'lucide-vue-next'

export interface CategoryVisual {
  icon: Component
  classes: string
}

export const categoryVisuals: Record<string, CategoryVisual> = {
  [Category.Food]: {
    icon: ShoppingBasket,
    classes: 'bg-success-soft text-success',
  },
  [Category.Health]: {
    icon: HeartPulse,
    classes: 'bg-primary-soft text-primary',
  },
  [Category.Education]: {
    icon: GraduationCap,
    classes: 'bg-violet-soft text-violet',
  },
  [Category.Housing]: {
    icon: House,
    classes: 'bg-amber-100 text-amber-800',
  },
  [Category.Clothing]: {
    icon: Shirt,
    classes: 'bg-pink-100 text-pink-700',
  },
  [Category.Tourism]: {
    icon: Plane,
    classes: 'bg-teal-100 text-teal-800',
  },
  [Category.Other]: {
    icon: Shapes,
    classes: 'bg-red-100 text-red-800',
  },
  [Category.Uncategorized]: {
    icon: CircleHelp,
    classes: 'bg-slate-100 text-slate-700',
  },
  Empate: {
    icon: Scale,
    classes: 'bg-warning-soft text-warning',
  },
  Corregida: {
    icon: PencilLine,
    classes: 'bg-warning-soft text-warning',
  },
}

export const unknownCategoryVisual: CategoryVisual = {
  icon: CircleHelp,
  classes: 'bg-slate-100 text-slate-700',
}

export function categoryVisual(category: string): CategoryVisual {
  return categoryVisuals[category] ?? unknownCategoryVisual
}
