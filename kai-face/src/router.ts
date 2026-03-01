import { lazy } from "react";
import {
  createRouter,
  createRootRoute,
  createRoute,
} from "@tanstack/react-router";
import RootLayout from "./routes/__root";
import AppLayout from "./routes/_app";

const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const PowerBuilder = lazy(() => import("./components/powers/PowerBuilder"));

const rootRoute = createRootRoute({
  component: RootLayout,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_app",
  component: AppLayout,
});

const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: DashboardPage,
});

const powersNewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/powers/new",
  component: PowerBuilder,
});

const routeTree = rootRoute.addChildren([
  appRoute.addChildren([dashboardRoute, powersNewRoute]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
