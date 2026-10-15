import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import AdminGate from './components/AdminGate.jsx';
import { ToastProvider } from './components/ui.jsx';
import Checkout from './pages/Checkout.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Offers from './pages/Offers.jsx';
import Coupons from './pages/Coupons.jsx';
import Programs from './pages/Programs.jsx';
import Users from './pages/Users.jsx';
import Audit from './pages/Audit.jsx';

export default function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/checkout" replace />} />
          <Route path="/checkout" element={<Checkout />} />
          <Route path="/admin" element={<AdminGate />}>
            <Route index element={<Dashboard />} />
            <Route path="offers" element={<Offers />} />
            <Route path="coupons" element={<Coupons />} />
            <Route path="programs" element={<Programs />} />
            <Route path="users" element={<Users />} />
            <Route path="audit" element={<Audit />} />
          </Route>
          <Route path="*" element={<Navigate to="/checkout" replace />} />
        </Route>
      </Routes>
    </ToastProvider>
  );
}
