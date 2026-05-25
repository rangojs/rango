// Static catalog shared by the products-table loader (pagination source) and
// the cart loader (resolves line names from product ids). Plain module, no
// directives, so both the server loaders and the "use server" cart action can
// import it.

export interface CatalogProduct {
  id: string;
  name: string;
  price: number;
  rating: number;
  stock: number;
}

export const CATALOG: CatalogProduct[] = [
  { id: "widget", name: "Acme Widget", price: 129, rating: 4.8, stock: 312 },
  { id: "gizmo", name: "Hyper Gizmo", price: 89, rating: 4.5, stock: 120 },
  {
    id: "sprocket",
    name: "Brass Sprocket",
    price: 54,
    rating: 4.2,
    stock: 540,
  },
  { id: "cog", name: "Titanium Cog", price: 210, rating: 4.9, stock: 47 },
  { id: "lever", name: "Quantum Lever", price: 75, rating: 4.1, stock: 233 },
  { id: "dial", name: "Chrono Dial", price: 162, rating: 4.7, stock: 88 },
  { id: "valve", name: "Plasma Valve", price: 38, rating: 3.9, stock: 612 },
  { id: "rotor", name: "Vortex Rotor", price: 145, rating: 4.6, stock: 154 },
  { id: "module", name: "Flux Module", price: 99, rating: 4.4, stock: 271 },
];

// Page size for the "Load more" pagination.
export const PAGE_SIZE = 3;
