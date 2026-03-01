import { Suspense } from "react";
import { Outlet } from "@tanstack/react-router";

export default function AppLayout() {
  return (
    <div className="flex flex-col h-screen">
      <div className="flex-1 overflow-hidden">
        <Suspense fallback={<div className="flex items-center justify-center h-full"><div className="h-5 w-5 rounded-full border-2 border-gray-700 border-t-gray-400 animate-spin" /></div>}>
          <Outlet />
        </Suspense>
      </div>
    </div>
  );
}
