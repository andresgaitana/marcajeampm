import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listEmployees,
  listAttendance,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  resetEmployeePin,
  listEmployeeAssignments,
  setEmployeeAssignments,
  checkAdmin,
  listAdminUsers,
  upsertAdminUser,
  removeAdminRole,
  setUserZones,
  setUserStores,
  seedZoneManagers,
  seedOperationsManager,
  seedStoreManagers,
  seedExtraSuperAdmins,
} from "@/lib/admin.functions";
import {
  listStores,
  createStore,
  updateStore,
  deleteStore,
  bulkCreateStores,
  setStoreTerminalPin,
  resetManagerPassword,
} from "@/lib/stores.functions";
import {
  listZones,
  createZone,
  updateZone,
  deleteZone,
} from "@/lib/zones.functions";
import {
  beginWebauthnRegistration,
  finishWebauthnRegistration,
  listEmployeeCredentials,
  deleteEmployeeCredential,
} from "@/lib/webauthn.functions";
import { startRegistration } from "@simplewebauthn/browser";
import { getDashboardMetrics, getEmployeeSummary, getEmployeeWeeklyMarks, getWeeklySchedule, getSchedulePrint, exportAttendance, getStaffingReport, getAttendanceKpis, getCoverageReport, getScheduleAdherence, getStaffingBudgetReport, getManagerMarks, getStoreEntryHours, setStoreEntryHour } from "@/lib/dashboard.functions";
import { getScheduleContext, generateSchedule, saveSchedule, setEmployeeScheduleAttrs } from "@/lib/schedule.functions";
import { SHIFT_KEYS as SCH_SHIFT_KEYS, SHIFT_DEF as SCH_SHIFT_DEF, DAYS as SCH_DAYS, validate as schedValidate, type Coverage as SchedCoverage, type SchedPerson, type Schedule as SchedGrid, type Alert as SchedAlert, type ShiftKey as SchedShiftKey } from "@/lib/schedule-engine";
import { SelfieCapture } from "@/components/SelfieCapture";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Plus, Trash2, Pencil, Download, LogIn, LogOut, Users, History,
  LayoutDashboard, Store as StoreIcon, AlertTriangle, Sparkles, Fingerprint, MapPin,
  Map as MapZoneIcon, ShieldCheck, Calendar as CalendarIcon, ChevronRight, Camera, KeyRound, ClipboardList,
  ClipboardCheck, ArrowLeftRight, CalendarPlus, Loader2, Printer, UserMinus, UserCheck, Clock,
} from "lucide-react";
import { normalizeEmployeeCode, CODE_HELP } from "@/lib/employee-code";

/**
 * Mensaje de error presentable para el GT. La validación del servidor (zod)
 * devuelve un volcado JSON con la lista de problemas; mostrarlo crudo en un toast
 * era ilegible. Extraemos el primer mensaje real.
 */
function errorMsg(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message.trim() : "";
  if (!raw) return fallback;
  if (raw.startsWith("[") || raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      const first = Array.isArray(parsed) ? parsed[0] : parsed;
      return typeof first?.message === "string" ? first.message : fallback;
    } catch {
      return fallback;
    }
  }
  return raw;
}
import { toast } from "sonner";

/** Error boundary del panel: si un panel lanza una excepción, muestra un aviso con
 * botón de reintentar (y el mensaje del error) en vez de tumbar toda la página. */
function AdminSectionError({ error, reset }: { error: Error; reset: () => void }) {
  // El traductor del navegador reemplaza los nodos de texto y React falla al quitarlos.
  // Ahí "Reintentar" no sirve (el DOM ya quedó mezclado): hay que recargar.
  const traductor = /removeChild|insertBefore|NotFoundError|not a child of this node/i.test(
    String(error?.message ?? ""),
  );
  return (
    <div className="max-w-lg mx-auto text-center py-16 px-4">
      <AlertTriangle className="h-10 w-10 text-amber-600 mx-auto mb-3" />
      <h2 className="text-lg font-bold text-foreground">No se pudo cargar esta sección</h2>
      <p className="text-sm text-muted-foreground mt-1">
        {traductor
          ? "El traductor del navegador está interfiriendo con la página. Recárgala y, si Chrome ofrece traducirla, elige «No traducir»."
          : "Ocurrió un error al mostrar los datos. Reintenta; si persiste, recarga la página completa."}
      </p>
      <p className="text-xs text-muted-foreground/70 mt-3 font-mono break-words">{error?.message}</p>
      <div className="mt-4 flex gap-2 justify-center">
        {!traductor && <Button variant="outline" onClick={() => reset()}>Reintentar</Button>}
        <Button
          className="bg-accent text-accent-foreground hover:bg-accent/90"
          onClick={() => window.location.reload()}
        >
          Recargar página
        </Button>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/admin/")({
  component: AdminDashboard,
  errorComponent: AdminSectionError,
});

type EmployeeRole =
  | "cajero"
  | "gerente"
  | "seguridad"
  | "agente_mbk"
  | "gerente_zona"
  | "personal_limpieza"
  | "seguridad_interna"
  | "seguridad_tercerizada";

const ROLE_LABELS: Record<EmployeeRole, string> = {
  cajero: "Cajero",
  agente_mbk: "Agente MBK",
  personal_limpieza: "Personal de Limpieza",
  seguridad_interna: "Seguridad Interna",
  seguridad_tercerizada: "Seguridad Tercerizada",
  seguridad: "Seguridad",
  gerente: "Gerente",
  gerente_zona: "Gerente de Zona",
};

const ADMIN_ROLE_LABELS: Record<string, string> = {
  admin: "Administrador",
  gerente_operaciones: "Gerente de Operaciones",
  gerente_zona: "Gerente de Zona (Admin)",
  gerente_tienda: "Gerente de Tienda",
};

/**
 * Filtro reutilizable por Zona y Tienda. Deriva las opciones de listStores
 * (ya limitado al alcance del usuario). Solo se muestra si hay más de una tienda
 * (un GT con una sola tienda no lo necesita).
 */
function useStoreFilter() {
  const storesFn = useServerFn(listStores);
  const { data } = useQuery({ queryKey: ["stores"], queryFn: () => storesFn() });
  const storeList = data ?? [];
  const [zoneId, setZoneId] = useState("all");
  const [storeId, setStoreId] = useState("all");

  const zones = useMemo(() => {
    const m = new Map<string, { id: string; label: string }>();
    for (const s of storeList) {
      const zRaw = (s as { zones?: { code?: string; name?: string } | { code?: string; name?: string }[] }).zones;
      const z = Array.isArray(zRaw) ? zRaw[0] : zRaw;
      if (s.zone_id && z) m.set(s.zone_id, { id: s.zone_id, label: `${z.code ?? ""} · ${z.name ?? ""}` });
    }
    return [...m.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [storeList]);

  const storesForZone = zoneId === "all" ? storeList : storeList.filter((s) => s.zone_id === zoneId);

  const matches = (sid?: string | null) => {
    if (storeId !== "all") return sid === storeId;
    if (zoneId !== "all") return storesForZone.some((s) => s.id === sid);
    return true;
  };

  const bar = storeList.length > 1 ? (
    <div className="flex flex-wrap items-center gap-2">
      {zones.length > 1 && (
        <Select value={zoneId} onValueChange={(v) => { setZoneId(v); setStoreId("all"); }}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Zona" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas las zonas</SelectItem>
            {zones.map((z) => <SelectItem key={z.id} value={z.id}>{z.label}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      <Select value={storeId} onValueChange={setStoreId}>
        <SelectTrigger className="w-52"><SelectValue placeholder="Tienda" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Todas las tiendas</SelectItem>
          {storesForZone.map((s) => <SelectItem key={s.id} value={s.id}>{s.code} · {s.name}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  ) : null;

  return { zoneId, storeId, matches, bar };
}

function AdminDashboard() {
  const checkFn = useServerFn(checkAdmin);
  const { data: access } = useQuery({ queryKey: ["adminAccess"], queryFn: () => checkFn() });
  const canManageOrg = !!(access?.isAdmin || access?.isOperations);
  const canSeeStores = canManageOrg || !!access?.isZoneAdmin;
  return (
    <Tabs defaultValue="dashboard" className="space-y-4">
      <TabsList className="bg-card border border-border flex-wrap h-auto">
        <TabsTrigger value="dashboard" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">
          <LayoutDashboard className="h-4 w-4 mr-2" />
          Dashboard
        </TabsTrigger>
        <TabsTrigger value="schedule" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">
          <CalendarIcon className="h-4 w-4 mr-2" />
          Horario
        </TabsTrigger>
        <TabsTrigger value="staffing" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">
          <ClipboardList className="h-4 w-4 mr-2" />
          Dotación
        </TabsTrigger>
        <TabsTrigger value="planner" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">
          <CalendarPlus className="h-4 w-4 mr-2" />
          Crear Horario
        </TabsTrigger>
        <TabsTrigger value="kpis" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">
          <ClipboardCheck className="h-4 w-4 mr-2" />
          Evaluación
        </TabsTrigger>
        <TabsTrigger value="attendance" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">
          <History className="h-4 w-4 mr-2" />
          Marcajes
        </TabsTrigger>
        <TabsTrigger value="coverage" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">
          <ArrowLeftRight className="h-4 w-4 mr-2" />
          Coberturas
        </TabsTrigger>
        <TabsTrigger value="employees" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">
          <Users className="h-4 w-4 mr-2" />
          Colaboradores
        </TabsTrigger>
        {canSeeStores && (
          <TabsTrigger value="stores" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">
            <StoreIcon className="h-4 w-4 mr-2" />
            Tiendas
          </TabsTrigger>
        )}
        {canManageOrg && (
          <TabsTrigger value="zones" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">
            <MapZoneIcon className="h-4 w-4 mr-2" />
            Zonas
          </TabsTrigger>
        )}
        {canManageOrg && (
          <TabsTrigger value="admins" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">
            <ShieldCheck className="h-4 w-4 mr-2" />
            Usuarios admin
          </TabsTrigger>
        )}
      </TabsList>
      <TabsContent value="dashboard">
        <DashboardPanel />
      </TabsContent>
      <TabsContent value="schedule">
        <WeeklySchedulePanel />
      </TabsContent>
      <TabsContent value="staffing">
        <StaffingPanel />
      </TabsContent>
      <TabsContent value="planner">
        <SchedulePlannerPanel />
      </TabsContent>
      <TabsContent value="kpis">
        <KpiPanel />
      </TabsContent>
      <TabsContent value="attendance">
        <AttendancePanel />
      </TabsContent>
      <TabsContent value="coverage">
        <CoveragePanel />
      </TabsContent>
      <TabsContent value="employees">
        <EmployeesPanel />
      </TabsContent>
      {canSeeStores && (
        <TabsContent value="stores">
          {canManageOrg ? <StoresPanel /> : <ZoneStoresPanel />}
        </TabsContent>
      )}
      {canManageOrg && (
        <TabsContent value="zones">
          <ZonesPanel />
        </TabsContent>
      )}
      {canManageOrg && (
        <TabsContent value="admins">
          <AdminUsersPanel isAdmin={!!access?.isAdmin} />
        </TabsContent>
      )}
    </Tabs>
  );
}

function AttendancePanel() {
  const fetchFn = useServerFn(listAttendance);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["attendance"],
    queryFn: () => fetchFn({ data: { limit: 200 } }),
    refetchInterval: 15_000,
    retry: 1,
  });

  const filter = useStoreFilter();
  const rows = (data ?? []).filter((r) => filter.matches(r.store_id));

  const exportCsv = () => {
    const header = ["Fecha", "Hora", "Colaborador", "Código", "Rol", "Tienda", "Tipo"];
    const lines = rows.map((r) => {
      const d = new Date(r.created_at);
      const emp = Array.isArray(r.employee) ? r.employee[0] : r.employee;
      const st = Array.isArray(r.store) ? r.store[0] : r.store;
      return [
        d.toLocaleDateString("es-MX"),
        d.toLocaleTimeString("es-MX"),
        emp?.full_name ?? "",
        emp?.employee_code ?? "",
        emp?.role ?? "",
        st ? `${st.code} · ${st.name}` : "",
        r.type,
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",");
    });
    const csv = [header.join(","), ...lines].join("\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `marcajes-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-foreground">Historial de marcajes</h2>
          <p className="text-sm text-muted-foreground">Últimos {rows.length} registros (se actualiza cada 15s)</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {filter.bar}
          <Button onClick={exportCsv} variant="outline" disabled={rows.length === 0}>
            <Download className="h-4 w-4 mr-2" /> Exportar CSV
          </Button>
        </div>
      </div>

      <div className="bg-card rounded-2xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-secondary/50">
              <TableHead>Selfie</TableHead>
              <TableHead>Fecha / Hora</TableHead>
              <TableHead>Colaborador</TableHead>
              <TableHead>Rol</TableHead>
              <TableHead>Tienda</TableHead>
              <TableHead>Tipo</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isError ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-destructive">
                  No se pudieron cargar los marcajes: {error instanceof Error ? error.message : "error desconocido"}
                </TableCell>
              </TableRow>
            ) : isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  Cargando…
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  Aún no hay marcajes registrados.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => {
                const d = new Date(r.created_at);
                const emp = Array.isArray(r.employee) ? r.employee[0] : r.employee;
                const st = Array.isArray(r.store) ? r.store[0] : r.store;
                return (
                  <TableRow key={r.id}>
                    <TableCell>
                      {r.selfie_url ? (
                        <a href={r.selfie_url} target="_blank" rel="noopener noreferrer">
                          <img
                            src={r.selfie_url}
                            alt="selfie"
                            className="h-12 w-12 rounded-lg object-cover border border-border"
                          />
                        </a>
                      ) : (
                        <div className="h-12 w-12 rounded-lg bg-muted" />
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium text-foreground">{d.toLocaleDateString("es-MX")}</div>
                      <div className="text-xs text-muted-foreground font-mono">
                        {d.toLocaleTimeString("es-MX")}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium text-foreground">{emp?.full_name}</div>
                      <div className="text-xs text-muted-foreground">{emp?.employee_code}</div>
                      {r.notes && <div className="text-xs text-purple-700 mt-0.5">{r.notes}</div>}
                    </TableCell>
                    <TableCell className="capitalize text-muted-foreground">{emp?.role}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {st ? `${st.code} · ${st.name}` : "—"}
                    </TableCell>
                    <TableCell>
                      {r.type === "entrada" ? (
                        <Badge className="bg-primary text-primary-foreground hover:bg-primary">
                          <LogIn className="h-3 w-3 mr-1" /> Entrada
                        </Badge>
                      ) : (
                        <Badge className="bg-accent text-accent-foreground hover:bg-accent">
                          <LogOut className="h-3 w-3 mr-1" /> Salida
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function EmployeesPanel() {
  const fetchFn = useServerFn(listEmployees);
  const createFn = useServerFn(createEmployee);
  const updateFn = useServerFn(updateEmployee);
  const deleteFn = useServerFn(deleteEmployee);
  const resetPinFn = useServerFn(resetEmployeePin);
  const storesFn = useServerFn(listStores);
  const checkFn = useServerFn(checkAdmin);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["employees"],
    queryFn: () => fetchFn(),
  });
  const { data: stores } = useQuery({ queryKey: ["stores"], queryFn: () => storesFn() });
  const { data: access } = useQuery({ queryKey: ["adminAccess"], queryFn: () => checkFn() });

  // Un Gerente de Tienda "puro" (sin admin/ops/zona) tiene permisos limitados.
  const isOnlyStoreAdmin =
    !!access?.isStoreAdmin && !access?.isAdmin && !access?.isOperations && !access?.isZoneAdmin;
  const isSuper = !!(access?.isAdmin || access?.isOperations);
  const isZoneOnly = !!access?.isZoneAdmin && !isSuper;
  // Quién puede restablecer el PIN de cada colaborador (refleja la regla del backend):
  //  - Super admin/Ops: todos.  - GZ: todos menos otro GZ.  - GT: solo sus Agentes.
  const canResetPin = (role: string) => {
    if (isSuper) return true;
    if (isZoneOnly) return role !== "gerente_zona";
    if (isOnlyStoreAdmin) return ["cajero", "agente_mbk", "personal_limpieza", "seguridad_interna", "seguridad_tercerizada", "seguridad"].includes(role);
    return false;
  };
  const allowedRoles: EmployeeRole[] = isOnlyStoreAdmin
    ? ["cajero", "agente_mbk", "personal_limpieza", "seguridad_interna", "seguridad_tercerizada"]
    : ["cajero", "agente_mbk", "personal_limpieza", "seguridad_interna", "seguridad_tercerizada", "gerente", "gerente_zona"];

  const filter = useStoreFilter();
  const employees = (data ?? []).filter((e) => filter.matches(e.store_id));
  const storeList = stores ?? [];
  // La seguridad tercerizada es cuenta rotativa compartida; el GZ no es de tienda.
  const needsCedula = (role: string) => role !== "seguridad_tercerizada" && role !== "gerente_zona";
  const missingCedula = employees.filter((e) => e.active && needsCedula(e.role) && !e.cedula);
  // Todos marcan con rostro EXCEPTO la seguridad tercerizada (cuenta rotativa). Sin el
  // rostro de referencia, la persona no puede marcar: es el paso que más se olvida.
  const needsFace = (role: string) => role !== "seguridad_tercerizada";
  const missingFace = employees.filter((e) => e.active && needsFace(e.role) && !e.face_enrolled_at);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<(typeof employees)[number] | null>(null);
  const [form, setForm] = useState({
    employee_code: "",
    full_name: "",
    cedula: "",
    polivalente: false,
    role: "cajero" as EmployeeRole,
    store_id: "",
    pin: "",
    active: true,
    face_descriptor: null as number[] | null,
  });
  const [showRefCapture, setShowRefCapture] = useState(false);
  const [saving, setSaving] = useState(false);
  const [enrollFor, setEnrollFor] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    if (editing) {
      setForm({
        employee_code: editing.employee_code,
        full_name: editing.full_name,
        cedula: editing.cedula ?? "",
        polivalente: editing.polivalente ?? false,
        role: editing.role as EmployeeRole,
        store_id: editing.store_id ?? "",
        pin: "",
        active: editing.active,
        face_descriptor: null,
      });
    } else {
      setForm({
        employee_code: "",
        full_name: "",
        cedula: "",
        polivalente: false,
        role: "cajero",
        store_id: storeList[0]?.id ?? "",
        pin: "",
        active: true,
        face_descriptor: null,
      });
    }
    setShowRefCapture(false);
  }, [editing, open, storeList]);

  const save = async () => {
    if (!form.store_id) {
      toast.error("Selecciona una tienda");
      return;
    }
    if (!form.employee_code) {
      toast.error(`Escribe el código del colaborador. ${CODE_HELP}`);
      return;
    }
    if (saving) return; // evita que un doble clic cree al colaborador dos veces
    setSaving(true);
    // Traslado permanente: cambió la tienda de un colaborador ya existente. Se confirma
    // porque reasigna de forma definitiva; el historial de marcajes anterior NO se mueve
    // (cada marcaje queda en la tienda donde ocurrió), solo cambia dónde marca de ahora
    // en adelante.
    if (editing && form.store_id !== editing.store_id) {
      const antigua = storeList.find((s) => s.id === editing.store_id);
      const nueva = storeList.find((s) => s.id === form.store_id);
      if (!window.confirm(
        `¿Trasladar a ${form.full_name} de ${antigua?.code ?? "su tienda"} a ${nueva?.code ?? "la nueva tienda"}?\n\n` +
        `Desde ahora marcará en ${nueva?.code ?? "la nueva tienda"}. Sus marcajes anteriores se conservan en ${antigua?.code ?? "la tienda anterior"} (no se mueven).`,
      )) {
        setSaving(false);
        return;
      }
    }
    try {
      if (editing) {
        await updateFn({
          data: {
            id: editing.id,
            ...(form.employee_code && form.employee_code !== editing.employee_code
              ? { employee_code: form.employee_code }
              : {}),
            full_name: form.full_name,
            cedula: form.cedula,
            polivalente: form.role === "cajero" || form.role === "agente_mbk" ? form.polivalente : false,
            role: form.role,
            store_id: form.store_id,
            active: form.active,
            ...(form.pin ? { pin: form.pin } : {}),
            ...(form.face_descriptor ? { face_descriptor: form.face_descriptor } : {}),
          },
        });
        toast.success("Colaborador actualizado");
      } else {
        // La Seguridad Tercerizada usa un usuario compartido por tienda (rota el
        // personal), por eso no exige foto de referencia.
        if (!form.face_descriptor && form.role !== "seguridad_tercerizada") {
          toast.error("Toma la foto de referencia del colaborador (reconocimiento facial)");
          return;
        }
        await createFn({
          data: {
            employee_code: form.employee_code,
            full_name: form.full_name,
            cedula: form.cedula,
            polivalente: form.role === "cajero" || form.role === "agente_mbk" ? form.polivalente : false,
            role: form.role,
            store_id: form.store_id,
            pin: form.pin,
            active: form.active,
            ...(form.face_descriptor ? { face_descriptor: form.face_descriptor } : {}),
          },
        });
        toast.success(`Colaborador creado. Marca con el código ${form.employee_code}`);
      }
      setOpen(false);
      setEditing(null);
      qc.invalidateQueries({ queryKey: ["employees"] });
    } catch (e: unknown) {
      toast.error(errorMsg(e, "No se pudo guardar el colaborador"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    // El servidor solo permite borrar de verdad a quien NO tiene marcajes (un
    // registro creado por error). Para quien dejó de laborar existe la baja.
    if (!confirm("¿Eliminar este registro?\n\nSolo se puede eliminar a quien nunca ha marcado. Si ya trabajó, usa «Dar de baja» para conservar su historial.")) return;
    try {
      await deleteFn({ data: { id } });
      toast.success("Registro eliminado");
      qc.invalidateQueries({ queryKey: ["employees"] });
    } catch (e: unknown) {
      toast.error(errorMsg(e, "No se pudo eliminar"));
    }
  };

  /** Baja lógica: el colaborador dejó de laborar pero su historial se conserva. */
  const toggleActive = async (e: { id: string; full_name: string; active: boolean; employee_code: string }) => {
    const esBaja = e.active;
    const msg = esBaja
      ? `¿Dar de baja a ${e.full_name}?\n\nDejará de aparecer en la tienda, en los horarios y en la dotación, y ya no podrá marcar.\nSu historial de marcajes se conserva completo.\n\nSi regresa, lo podés reactivar.`
      : `¿Reactivar a ${e.full_name}?\n\nVolverá a marcar con su código ${e.employee_code}.`;
    if (!confirm(msg)) return;
    try {
      await updateFn({ data: { id: e.id, active: !e.active } });
      toast.success(esBaja ? `${e.full_name} quedó dado de baja` : `${e.full_name} fue reactivado`);
      qc.invalidateQueries({ queryKey: ["employees"] });
    } catch (err: unknown) {
      toast.error(errorMsg(err, "No se pudo actualizar"));
    }
  };

  const resetPin = async (id: string, name: string) => {
    if (!confirm(`¿Restablecer el PIN de ${name} a 1234?\nDeberá crear un PIN nuevo en su próximo marcaje.`)) return;
    try {
      await resetPinFn({ data: { id } });
      toast.success(`PIN restablecido a 1234. ${name} deberá cambiarlo al marcar.`);
      qc.invalidateQueries({ queryKey: ["employees"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error al restablecer el PIN");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-foreground">Colaboradores</h2>
          <p className="text-sm text-muted-foreground">{employees.length} registrados</p>
        </div>
        {filter.bar}
        <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setEditing(null); }}>
          <DialogTrigger asChild>
            <Button className="bg-accent text-accent-foreground hover:bg-accent/90">
              <Plus className="h-4 w-4 mr-2" /> Nuevo colaborador
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[90dvh] flex flex-col">
            <DialogHeader className="shrink-0">
              <DialogTitle>{editing ? "Editar colaborador" : "Nuevo colaborador"}</DialogTitle>
            </DialogHeader>
            {/* Campos con scroll propio: en teléfonos el formulario es alto (cédula,
                polivalente, foto) y el footer Guardar debe quedar siempre visible. */}
            <div className="space-y-3 overflow-y-auto flex-1 min-h-0 pr-1 -mr-1">
              <div>
                <Label>Código de empleado</Label>
                {/* Se normaliza mientras se teclea: el GT ve exactamente lo que se
                    va a guardar y lo que su colaborador tendrá que teclear al marcar. */}
                <Input
                  value={form.employee_code}
                  onChange={(e) =>
                    setForm({ ...form, employee_code: normalizeEmployeeCode(e.target.value) })
                  }
                  placeholder="Ej. A6901"
                  className="font-mono uppercase"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {CODE_HELP} Es con el que marca, y no se puede repetir en ninguna tienda.
                </p>
                {editing && form.employee_code !== editing.employee_code && (
                  <p className="text-xs text-amber-700 mt-1">
                    Cambiarás el código de <strong>{editing.employee_code}</strong> a{" "}
                    <strong>{form.employee_code || "—"}</strong>. Sus marcajes anteriores se
                    conservan, pero avísale: desde ahora marca con el código nuevo.
                  </p>
                )}
              </div>
              <div>
                <Label>Nombre completo</Label>
                <Input
                  value={form.full_name}
                  onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                />
              </div>
              {form.role !== "seguridad_tercerizada" && (
                <div>
                  <Label>Cédula</Label>
                  <Input
                    value={form.cedula}
                    onChange={(e) => setForm({ ...form, cedula: e.target.value })}
                    placeholder="Ej. 001-010190-0001A"
                  />
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Rol</Label>
                  <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v as EmployeeRole })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {allowedRoles.map((r) => (
                        <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>{form.role === "gerente_zona" ? "Tienda base (inicial)" : "Tienda"}</Label>
                  <Select value={form.store_id} onValueChange={(v) => setForm({ ...form, store_id: v })}>
                    <SelectTrigger><SelectValue placeholder="Selecciona…" /></SelectTrigger>
                    <SelectContent>
                      {storeList.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.code} · {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {(form.role === "cajero" || form.role === "agente_mbk") && (
                <label className="flex items-start gap-2 text-sm rounded-lg border border-border p-3">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={form.polivalente}
                    onChange={(e) => setForm({ ...form, polivalente: e.target.checked })}
                  />
                  <span>
                    <span className="font-medium text-foreground">Polivalente (apoya en la otra área)</span>
                    <span className="block text-xs text-muted-foreground">
                      Cajero que también cubre en {form.role === "cajero" ? "MBK" : "Productos"}. Al marcar
                      ENTRADA se le preguntará en qué área trabajará ese turno.
                    </span>
                  </span>
                </label>
              )}
              {form.role === "gerente_zona" && editing && (
                <ZoneAssignmentsEditor
                  employeeId={editing.id}
                  stores={storeList.map((s) => ({ id: s.id, code: s.code, name: s.name }))}
                />
              )}
              {form.role === "gerente_zona" && !editing && (
                <p className="text-xs text-muted-foreground bg-secondary/60 rounded-lg p-2">
                  Crea primero al Gerente de Zona y luego edítalo para asignarle las tiendas que supervisará.
                </p>
              )}
              <div>
                <Label>{editing ? "PIN nuevo (dejar vacío para mantener)" : "PIN (4-8 dígitos)"}</Label>
                <Input
                  type="text"
                  inputMode="numeric"
                  pattern="\d*"
                  maxLength={8}
                  value={form.pin}
                  onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, "") })}
                  placeholder={editing ? "••••" : "Ej. 1234"}
                />
              </div>
              <div className="rounded-lg border border-border p-3 space-y-2">
                <Label>Foto de referencia (reconocimiento facial)</Label>
                {showRefCapture ? (
                  <SelfieCapture
                    requireDescriptor
                    confirmLabel="Usar esta foto"
                    onCapture={(_url, desc) => {
                      setForm((f) => ({ ...f, face_descriptor: desc }));
                      setShowRefCapture(false);
                    }}
                    onCancel={() => setShowRefCapture(false)}
                  />
                ) : form.face_descriptor ? (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-[oklch(0.55_0.14_155)] font-medium">✓ Rostro de referencia capturado</span>
                    <Button type="button" variant="outline" size="sm" onClick={() => setShowRefCapture(true)}>
                      Volver a tomar
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      {editing
                        ? "Opcional: re-capturar para actualizar."
                        : form.role === "seguridad_tercerizada"
                          ? "No requerida: la Seguridad Tercerizada usa un usuario compartido por tienda (rota el personal); la selfie de cada marcaje queda como evidencia."
                          : "Obligatoria: se usará para validar su identidad al marcar."}
                    </span>
                    <Button type="button" variant="outline" size="sm" onClick={() => setShowRefCapture(true)}>
                      <Camera className="h-4 w-4 mr-1" /> Tomar foto
                    </Button>
                  </div>
                )}
              </div>
              <p className="text-xs text-muted-foreground">El colaborador marcará entrada/salida con PIN + Huella. Registra la huella después con el botón <span className="inline-flex items-center gap-1"><Fingerprint className="h-3 w-3" /></span> en la lista. Los accesos de Administrador, Gerente de Operaciones y Gerente de Zona se gestionan en la pestaña <strong>Usuarios admin</strong>.</p>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(e) => setForm({ ...form, active: e.target.checked })}
                />
                Activo
              </label>
            </div>
            <DialogFooter className="shrink-0 border-t border-border pt-3">
              <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancelar</Button>
              <Button onClick={save} disabled={saving} className="bg-accent text-accent-foreground hover:bg-accent/90">
                {saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Guardando…</> : "Guardar"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {missingCedula.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-1 text-amber-800 font-semibold">
            <AlertTriangle className="h-4 w-4" />
            Actualización pendiente: cédula de colaboradores
          </div>
          <p className="text-sm text-amber-800">
            {missingCedula.length} colaborador(es) sin cédula. Toca a cada uno para editarlo y agregar su cédula (Agentes y Gerentes de tienda).
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {missingCedula.slice(0, 40).map((e) => (
              <button
                key={e.id}
                onClick={() => { setEditing(e); setOpen(true); }}
                className="text-xs rounded-md border border-amber-300 bg-white text-amber-800 px-2 py-1 hover:bg-amber-100"
              >
                {e.full_name} <span className="font-mono opacity-70">{e.employee_code}</span>
              </button>
            ))}
            {missingCedula.length > 40 && <span className="text-xs text-amber-700 self-center">+{missingCedula.length - 40} más</span>}
          </div>
        </div>
      )}

      {missingFace.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-1 text-red-800 font-semibold">
            <Camera className="h-4 w-4" /> Pendiente: enrolar rostro
          </div>
          <p className="text-sm text-red-800">
            {missingFace.length} colaborador(es) SIN rostro registrado: no pueden marcar hasta enrolarlos.
            Toca a cada uno para abrir su ficha y usa el botón de cámara. La selfie del marcaje no cuenta como enrolamiento.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {missingFace.slice(0, 40).map((e) => (
              <button
                key={e.id}
                onClick={() => { setEnrollFor({ id: e.id, name: e.full_name }); }}
                className="text-xs rounded-md border border-red-300 bg-white text-red-800 px-2 py-1 hover:bg-red-100"
              >
                {e.full_name} <span className="font-mono opacity-70">{e.employee_code}</span>
              </button>
            ))}
            {missingFace.length > 40 && <span className="text-xs text-red-700 self-center">+{missingFace.length - 40} más</span>}
          </div>
        </div>
      )}

      <div className="bg-card rounded-2xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-secondary/50">
              <TableHead>Código</TableHead>
              <TableHead>Nombre</TableHead>
              <TableHead>Rol</TableHead>
              <TableHead>Tienda</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead className="text-right">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Cargando…</TableCell></TableRow>
            ) : employees.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                Aún no hay colaboradores. Crea el primero para empezar a marcar.
              </TableCell></TableRow>
            ) : employees.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="font-mono text-foreground">{e.employee_code}</TableCell>
                <TableCell className="font-medium text-foreground">
                  {e.full_name}
                  {e.cedula ? (
                    <div className="text-xs text-muted-foreground font-normal">CI: {e.cedula}</div>
                  ) : needsCedula(e.role) && e.active ? (
                    <div className="text-xs text-amber-700 font-normal">Sin cédula</div>
                  ) : null}
                </TableCell>
                <TableCell className="text-muted-foreground">{ROLE_LABELS[e.role as EmployeeRole] ?? e.role}</TableCell>
                <TableCell className="text-muted-foreground">
                  {(() => {
                    const s = storeList.find((x) => x.id === e.store_id);
                    return s ? `${s.code} · ${s.name}` : (e.store ?? "—");
                  })()}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {e.active ? (
                      <Badge className="bg-[oklch(0.65_0.16_155)] text-white hover:bg-[oklch(0.65_0.16_155)]">Activo</Badge>
                    ) : (
                      <Badge variant="secondary">Inactivo</Badge>
                    )}
                    {e.must_change_pin && (
                      <Badge variant="outline" className="border-amber-500 text-amber-700">PIN 1234 · por cambiar</Badge>
                    )}
                    {e.active && needsFace(e.role) && !e.face_enrolled_at && (
                      <Badge className="bg-destructive text-destructive-foreground hover:bg-destructive">Sin rostro</Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  {needsFace(e.role) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      title={e.face_enrolled_at ? "Rostro registrado · volver a tomar" : "Enrolar rostro (necesario para marcar)"}
                      onClick={() => setEnrollFor({ id: e.id, name: e.full_name })}
                    >
                      <Camera className={`h-4 w-4 ${e.face_enrolled_at ? "text-[oklch(0.6_0.13_155)]" : "text-destructive"}`} />
                    </Button>
                  )}
                  <FingerprintButton employeeId={e.id} employeeName={e.full_name} />
                  {canResetPin(e.role) && (
                    <Button variant="ghost" size="sm" title="Restablecer PIN a 1234" onClick={() => resetPin(e.id, e.full_name)}>
                      <KeyRound className="h-4 w-4 text-amber-600" />
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" title="Editar" onClick={() => { setEditing(e); setOpen(true); }}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  {(!isOnlyStoreAdmin || ["cajero", "agente_mbk", "personal_limpieza", "seguridad_interna", "seguridad_tercerizada", "seguridad"].includes(e.role)) && (
                    <>
                      {/* Baja lógica: la acción normal cuando alguien deja de laborar. */}
                      <Button
                        variant="ghost"
                        size="sm"
                        title={e.active ? "Dar de baja (conserva su historial)" : "Reactivar"}
                        onClick={() => toggleActive(e)}
                      >
                        {e.active
                          ? <UserMinus className="h-4 w-4 text-amber-600" />
                          : <UserCheck className="h-4 w-4 text-[oklch(0.65_0.16_155)]" />}
                      </Button>
                      <Button variant="ghost" size="sm" title="Eliminar registro (solo si nunca ha marcado)" onClick={() => remove(e.id)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <EnrollFaceDialog
        employee={enrollFor}
        onClose={() => setEnrollFor(null)}
        onDone={() => qc.invalidateQueries({ queryKey: ["employees"] })}
      />
    </div>
  );
}

// =====================================================================
// DASHBOARD
// =====================================================================
function ZoneAssignmentsEditor({
  employeeId,
  stores,
}: {
  employeeId: string;
  stores: { id: string; code: string; name: string }[];
}) {
  const listFn = useServerFn(listEmployeeAssignments);
  const setFn = useServerFn(setEmployeeAssignments);
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["empAssignments", employeeId],
    queryFn: () => listFn({ data: { employee_id: employeeId } }),
  });
  const [selected, setSelected] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (data && selected === null) {
      setSelected(new Set(data.map((r) => r.store_id)));
    }
  }, [data, selected]);

  const toggle = (id: string) => {
    const next = new Set(selected ?? []);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const save = async () => {
    try {
      await setFn({ data: { employee_id: employeeId, store_ids: Array.from(selected ?? []) } });
      toast.success("Tiendas asignadas actualizadas");
      qc.invalidateQueries({ queryKey: ["empAssignments", employeeId] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error al asignar tiendas");
    }
  };

  return (
    <div className="rounded-xl border border-border p-3 bg-secondary/40 space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-sm">Tiendas que supervisa</Label>
        <Button size="sm" variant="outline" onClick={save} disabled={isLoading || selected === null}>
          Guardar asignaciones
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        El Gerente de Zona podrá marcar entrada/salida en cualquiera de las tiendas seleccionadas.
      </p>
      <div className="max-h-40 overflow-y-auto grid grid-cols-1 gap-1">
        {stores.map((s) => {
          const checked = selected?.has(s.id) ?? false;
          return (
            <label key={s.id} className="flex items-center gap-2 text-sm py-1">
              <input type="checkbox" checked={checked} onChange={() => toggle(s.id)} />
              <span className="font-mono text-xs text-muted-foreground">{s.code}</span>
              <span className="text-foreground">{s.name}</span>
            </label>
          );
        })}
        {stores.length === 0 && <p className="text-xs text-muted-foreground">No hay tiendas registradas.</p>}
      </div>
    </div>
  );
}

// =====================================================================
// DOTACIÓN: Real vs Plan
// =====================================================================
function todayNI(): string {
  return new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
}

function DotCell({ c }: { c: { real: number; plan: number; names: string[] } }) {
  const color = c.plan === 0 ? "text-muted-foreground" : c.real >= c.plan ? "text-[oklch(0.55_0.14_155)]" : "text-amber-700";
  return (
    <div className="min-w-0">
      <span className={`font-semibold ${color}`}>{c.real}/{c.plan}</span>
      {c.names.length > 0 && (
        <ul className="mt-0.5 space-y-0.5 text-xs text-muted-foreground">
          {c.names.map((n, i) => (
            <li key={i} className="leading-tight break-words">{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StaffingPanel() {
  const reportFn = useServerFn(getStaffingReport);
  const filter = useStoreFilter();
  const [date, setDate] = useState(todayNI());
  const [shift, setShift] = useState<"am" | "pm">("am");

  const args: { date: string; storeId?: string; zoneId?: string } = { date };
  if (filter.storeId !== "all") args.storeId = filter.storeId;
  else if (filter.zoneId !== "all") args.zoneId = filter.zoneId;

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["staffing", date, filter.zoneId, filter.storeId],
    queryFn: () => reportFn({ data: args }),
  });
  const rows = data?.rows ?? [];

  const exportCsv = () => {
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const cellTxt = (c: { real: number; plan: number; names: string[] }) =>
      `${c.real}/${c.plan}${c.names.length ? " — " + c.names.join("; ") : ""}`;
    const lbl = shift === "am" ? "AM" : "PM";
    const header = ["Tienda", "Nombre", `Productos ${lbl}`, `MBK ${lbl}`, "Real", "Plan", "%"];
    const lines = [header.join(",")].concat(
      rows.map((r) => {
        const p = shift === "am" ? r.prod.am : r.prod.pm;
        const m = shift === "am" ? r.mbk.am : r.mbk.pm;
        const real = p.real + m.real, plan = p.plan + m.plan;
        return [r.code, esc(r.name), esc(cellTxt(p)), esc(cellTxt(m)), String(real), String(plan), plan ? `${Math.round((real / plan) * 100)}%` : "—"].join(",");
      }),
    );
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `dotacion_${shift}_${date}.csv`; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-foreground">Dotación: Real vs Plan</h2>
          <p className="text-sm text-muted-foreground">
            Agentes que marcaron entrada vs el plan. Útil después de las 6:59am para validar el turno AM.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {filter.bar}
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value || todayNI())} className="w-40" />
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={rows.length === 0}>
            <Download className="h-4 w-4 mr-1" /> Exportar Excel
          </Button>
        </div>
      </div>
      <Tabs value={shift} onValueChange={(v) => setShift(v as "am" | "pm")}>
        <TabsList className="bg-secondary border border-border">
          <TabsTrigger value="am" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">Corte AM</TabsTrigger>
          <TabsTrigger value="pm" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">Corte PM</TabsTrigger>
        </TabsList>
        {(["am", "pm"] as const).map((s) => (
          <TabsContent key={s} value={s} className="mt-3">
            <div className="bg-card rounded-2xl border border-border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-secondary/50">
                    <TableHead>Tienda</TableHead>
                    <TableHead>Productos {s === "am" ? "AM" : "PM"}</TableHead>
                    <TableHead>MBK {s === "am" ? "AM" : "PM"}</TableHead>
                    <TableHead className="text-right">Real</TableHead>
                    <TableHead className="text-right">Plan</TableHead>
                    <TableHead className="text-right">%</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isError ? (
                    <TableRow><TableCell colSpan={6} className="text-center py-8 text-destructive">{error instanceof Error ? error.message : "Error"}</TableCell></TableRow>
                  ) : isLoading ? (
                    <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Cargando…</TableCell></TableRow>
                  ) : rows.length === 0 ? (
                    <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Sin tiendas en alcance.</TableCell></TableRow>
                  ) : rows.map((r) => {
                    const p = s === "am" ? r.prod.am : r.prod.pm;
                    const m = s === "am" ? r.mbk.am : r.mbk.pm;
                    const real = p.real + m.real;
                    const plan = p.plan + m.plan;
                    const pct = plan ? Math.round((real / plan) * 100) : 0;
                    return (
                      <TableRow key={r.id}>
                        <TableCell><span className="font-mono text-foreground">{r.code}</span> <span className="text-muted-foreground text-xs">{r.name}</span></TableCell>
                        <TableCell><DotCell c={p} /></TableCell>
                        <TableCell><DotCell c={m} /></TableCell>
                        <TableCell className="text-right font-medium">{real}</TableCell>
                        <TableCell className="text-right text-muted-foreground">{plan}</TableCell>
                        <TableCell className={`text-right font-semibold ${pct >= 100 ? "text-[oklch(0.55_0.14_155)]" : "text-amber-700"}`}>{plan ? pct + "%" : "—"}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </TabsContent>
        ))}
      </Tabs>
      <p className="text-xs text-muted-foreground">
        Productos = cajeros; MBK = Agente MBK. <strong>Real</strong> = quienes marcaron entrada en ese corte; <strong>Plan</strong> = meta según el presupuesto y el día. Verde = cumple, ámbar = falta. <strong>Exportar Excel</strong> baja el corte seleccionado.
      </p>
    </div>
  );
}

// =====================================================================
// COBERTURAS: apoyos entre tiendas (marcajes en modo cobertura)
// =====================================================================
function CoveragePanel() {
  const reportFn = useServerFn(getCoverageReport);
  const filter = useStoreFilter();
  const [days, setDays] = useState("14");

  const args: { days: number; storeId?: string; zoneId?: string } = { days: Number(days) };
  if (filter.storeId !== "all") args.storeId = filter.storeId;
  else if (filter.zoneId !== "all") args.zoneId = filter.zoneId;

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["coverage", days, filter.zoneId, filter.storeId],
    queryFn: () => reportFn({ data: args }),
  });
  const shifts = data?.shifts ?? [];

  // Hora local Nicaragua (UTC-6) desde un ISO UTC.
  const hhmm = (iso: string | null) =>
    iso ? new Date(new Date(iso).getTime() - 6 * 3600 * 1000).toISOString().slice(11, 16) : "—";
  const dmy = (d: string) => { const [, m, dd] = d.split("-"); return `${dd}/${m}`; };

  const exportCsv = () => {
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const header = ["Fecha", "Codigo", "Nombre", "Area", "Tienda origen (presto)", "Tienda cobertura (recibio)", "Entrada", "Salida", "Horas"];
    const lines = [header.join(",")].concat(
      shifts.map((s) => [
        s.date, s.code, esc(s.name), s.area ?? s.role,
        esc(`${s.homeStore} ${s.homeStoreName}`), esc(`${s.coverStore} ${s.coverStoreName}`),
        hhmm(s.entrada), s.enCurso ? "en curso" : hhmm(s.salida),
        s.hours != null ? String(s.hours) : "",
      ].join(",")),
    );
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `coberturas_${days}d.csv`; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-foreground">Coberturas / Apoyos entre tiendas</h2>
          <p className="text-sm text-muted-foreground">
            Colaboradores que marcaron en una tienda que no es la suya: la tienda que <strong>prestó</strong>, la que <strong>recibió</strong> el apoyo y las horas del turno, para reconocer en planilla.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {filter.bar}
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="7">7 días</SelectItem>
              <SelectItem value="14">14 días</SelectItem>
              <SelectItem value="30">30 días</SelectItem>
              <SelectItem value="60">60 días</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={shifts.length === 0}>
            <Download className="h-4 w-4 mr-1" /> Exportar Excel
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 max-w-md">
        <div className="bg-card rounded-2xl border border-border p-4">
          <div className="text-xs text-muted-foreground">Turnos de cobertura</div>
          <div className="text-2xl font-bold text-foreground">{data?.total_shifts ?? 0}</div>
        </div>
        <div className="bg-card rounded-2xl border border-border p-4">
          <div className="text-xs text-muted-foreground">Horas de apoyo</div>
          <div className="text-2xl font-bold text-foreground">{data?.total_hours ?? 0}</div>
        </div>
      </div>

      <div className="bg-card rounded-2xl border border-border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-secondary/50">
              <TableHead>Fecha</TableHead>
              <TableHead>Colaborador</TableHead>
              <TableHead>Área</TableHead>
              <TableHead>Prestó</TableHead>
              <TableHead>Cubrió en</TableHead>
              <TableHead>Entrada</TableHead>
              <TableHead>Salida</TableHead>
              <TableHead className="text-right">Horas</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isError ? (
              <TableRow><TableCell colSpan={8} className="text-center text-destructive py-8">{error instanceof Error ? error.message : "Error al cargar"}</TableCell></TableRow>
            ) : isLoading ? (
              <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">Cargando…</TableCell></TableRow>
            ) : shifts.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">Sin coberturas en el periodo.</TableCell></TableRow>
            ) : (
              shifts.map((s, i) => (
                <TableRow key={`${s.empId}-${s.entrada}-${i}`}>
                  <TableCell className="whitespace-nowrap">{dmy(s.date)}</TableCell>
                  <TableCell>
                    <div className="font-medium text-foreground">{s.name}</div>
                    <div className="text-xs text-muted-foreground font-mono">{s.code}</div>
                  </TableCell>
                  <TableCell>{s.area ?? s.role}</TableCell>
                  <TableCell className="whitespace-nowrap font-mono font-semibold">{s.homeStore}</TableCell>
                  <TableCell className="whitespace-nowrap font-mono font-semibold text-accent">{s.coverStore}</TableCell>
                  <TableCell className="font-mono">{hhmm(s.entrada)}</TableCell>
                  <TableCell className="font-mono">{s.enCurso ? <span className="text-amber-600">en curso</span> : hhmm(s.salida)}</TableCell>
                  <TableCell className="text-right font-semibold">{s.hours != null ? s.hours : "—"}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        <strong>Prestó</strong> = tienda base del colaborador · <strong>Cubrió en</strong> = tienda donde marcó el apoyo. Las horas cuentan cuando hay entrada y salida emparejadas (turno de hasta 14 h); “en curso” indica que aún no marca la salida.
      </p>
    </div>
  );
}

// =====================================================================
// EVALUACIÓN: KPI de Asistencia y Puntualidad (caja/MBK)
// =====================================================================
/** Sábado (yyyy-mm-dd) que inicia la semana de evaluación (Sáb→Vie) que contiene la fecha. */
function evalWeekStart(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const back = (d.getUTCDay() + 1) % 7; // Sáb=6→0, Dom=0→1, … Vie=5→6
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}
/** Turnos finalizados mínimos para nota completa (Productos 4, MBK 6). */
function minTurnos(role: string): number {
  return role === "MBK" ? 6 : 4;
}
type KpiState = "complete" | "building" | "nodata";
/** Estado de la nota: la nota se CONSTRUYE día a día. "complete" cuando se cumple el
 * mínimo de turnos (semana madura); "building" mientras se va llenando; "nodata" sin
 * marcajes que evaluar. La nota se muestra desde el primer turno (no se bloquea). */
function kpiState(finalizados: number, turnos: number, role: string): KpiState {
  if (turnos <= 0) return "nodata";
  return finalizados >= minTurnos(role) ? "complete" : "building";
}
/** Avance del corte: % de turnos finalizados sobre los esperados (4 Productos / 6 MBK).
 * Ej.: 2 de 4 = 50%. Llega a 100% cuando se cumple el mínimo para calificar. */
function avancePct(finalizados: number, role: string): number {
  return Math.min(100, Math.round((finalizados / minTurnos(role)) * 100));
}
function AvanceBadge({ pct }: { pct: number }) {
  const cls =
    pct >= 100 ? "bg-emerald-100 text-emerald-800 border-emerald-200"
    : pct >= 50 ? "bg-amber-100 text-amber-800 border-amber-200"
    : "bg-muted text-muted-foreground border-border";
  return <span className={`inline-flex items-center rounded-full border px-2 h-7 text-sm font-bold ${cls}`}>{pct}%</span>;
}

function ScoreBadge({ n }: { n: number }) {
  const cls =
    n >= 5 ? "bg-emerald-100 text-emerald-800 border-emerald-200"
    : n === 4 ? "bg-green-100 text-green-800 border-green-200"
    : n === 3 ? "bg-amber-100 text-amber-800 border-amber-200"
    : "bg-red-100 text-red-800 border-red-200";
  return <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full border text-sm font-bold ${cls}`}>{n}</span>;
}

function KpiPanel() {
  const kpiFn = useServerFn(getAttendanceKpis);
  const filter = useStoreFilter();
  // Semana por defecto = la ya CERRADA (Sáb→Vie anterior), para evaluar el sábado.
  const defaultWeek = addDaysISO(evalWeekStart(todayNI()), -7);
  const [weekStart, setWeekStart] = useState(defaultWeek);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // Si el usuario navega semanas a mano, dejamos de auto-saltar (para no rebotarlo).
  const userPickedWeek = useRef(false);
  const gotoWeek = (w: string) => { userPickedWeek.current = true; setWeekStart(w); };

  const args: { weekStart: string; storeId?: string; zoneId?: string } = { weekStart };
  if (filter.storeId !== "all") args.storeId = filter.storeId;
  else if (filter.zoneId !== "all") args.zoneId = filter.zoneId;

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["kpis", weekStart, filter.zoneId, filter.storeId],
    queryFn: () => kpiFn({ data: args }),
  });
  const rows = data?.rows ?? [];
  const weekEnd = addDaysISO(weekStart, 6);
  // Se auto-saltó a una semana con datos (no la de cierre) sin que el usuario navegara.
  const autoJumped = !userPickedWeek.current && weekStart !== defaultWeek;

  // Tiendas/zonas nuevas: si la semana por defecto está VACÍA pero hay datos en otra
  // semana del alcance, saltar automáticamente a la más reciente con datos (una vez, y
  // solo si el usuario no ha navegado a mano).
  useEffect(() => {
    if (userPickedWeek.current || !data) return;
    if (data.rows.length > 0) return;
    const lw = data.latestDataWeek;
    if (lw && lw !== weekStart) setWeekStart(lw);
  }, [data, weekStart]);

  const exportCsv = () => {
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const header = ["Tienda", "Colaborador", "Área", "Turnos finalizados", "Mínimo", "Avance % del corte", "Estado nota", "Incid. puntualidad", "Nota puntualidad", "Olvidos", "Ajustes", "Nota marcaje"];
    const estadoLbl: Record<KpiState, string> = { complete: "Completa", building: "En construcción", nodata: "Sin datos" };
    const lines = [header.join(",")].concat(
      rows.map((r) => {
        const state = kpiState(r.finalizados, r.turnos, r.role);
        const showNota = state !== "nodata";
        return [r.store, esc(r.name), r.role, r.finalizados, minTurnos(r.role), `${avancePct(r.finalizados, r.role)}%`, estadoLbl[state], r.incidencias, showNota ? r.scorePuntualidad : "", r.olvidos, r.ajustes, showNota ? r.scoreMarcaje : ""].join(",");
      }),
    );
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `kpi_asistencia_${weekStart}.csv`; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-foreground">KPI de Asistencia y Puntualidad</h2>
          <p className="text-sm text-muted-foreground">Para la evaluación semanal de caja y MBK. Nota sugerida 1-5 por KPI.</p>
          {autoJumped && (
            <p className="text-xs text-amber-700 mt-0.5">
              La semana de cierre aún no tiene marcajes en este alcance; mostrando la semana con datos más reciente ({fmtDM(weekStart)}–{fmtDM(weekEnd)}).
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {filter.bar}
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" onClick={() => gotoWeek(addDaysISO(weekStart, -7))}>‹</Button>
            <span className="text-sm font-medium tabular-nums w-24 text-center">{fmtDM(weekStart)} – {fmtDM(weekEnd)}</span>
            <Button variant="outline" size="sm" onClick={() => gotoWeek(addDaysISO(weekStart, 7))}>›</Button>
          </div>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={rows.length === 0}>
            <Download className="h-4 w-4 mr-1" /> Exportar Excel
          </Button>
        </div>
      </div>
      <div className="bg-card rounded-2xl border border-border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-secondary/50">
              <TableHead>Colaborador</TableHead>
              <TableHead>Tienda</TableHead>
              <TableHead>Área</TableHead>
              <TableHead className="text-center">Turnos fin.</TableHead>
              <TableHead className="text-center">Puntualidad</TableHead>
              <TableHead className="text-center">Marcaje correcto</TableHead>
              <TableHead className="text-center">Avance<br/><span className="text-xs font-normal text-muted-foreground">% del corte</span></TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isError ? (
              <TableRow><TableCell colSpan={8} className="text-center py-8 text-destructive">{error instanceof Error ? error.message : "Error"}</TableCell></TableRow>
            ) : isLoading ? (
              <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Cargando…</TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">Sin marcajes de caja/MBK en esta semana.</TableCell></TableRow>
            ) : rows.map((r) => {
              const min = minTurnos(r.role);
              const state = kpiState(r.finalizados, r.turnos, r.role);
              const showNota = state !== "nodata";
              const building = state === "building";
              return (
              <Fragment key={r.employeeId}>
                <TableRow className={state === "nodata" ? "opacity-70" : ""}>
                  <TableCell className="font-medium">
                    {r.name}
                    {building && <div className="text-[11px] text-amber-700">En construcción ({r.finalizados}/{min})</div>}
                    {state === "nodata" && <div className="text-[11px] text-muted-foreground">Sin marcajes</div>}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.store}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.role}</TableCell>
                  <TableCell className="text-center">
                    <span className={state === "complete" ? "font-medium" : "text-amber-700 font-semibold"}>{r.finalizados}</span>
                    <span className="text-muted-foreground text-xs">/{min}</span>
                  </TableCell>
                  <TableCell className="text-center">
                    {showNota ? (
                      <><span className="text-muted-foreground text-xs mr-2">{r.incidencias} incid.</span><ScoreBadge n={r.scorePuntualidad} /></>
                    ) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-center">
                    {showNota ? (
                      <><span className="text-muted-foreground text-xs mr-2">{r.olvidos} olv. / {r.ajustes} aj.</span><ScoreBadge n={r.scoreMarcaje} /></>
                    ) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-center">
                    <AvanceBadge pct={avancePct(r.finalizados, r.role)} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => setOpen((o) => ({ ...o, [r.employeeId]: !o[r.employeeId] }))}>
                      {open[r.employeeId] ? "Ocultar" : "Detalle"}
                    </Button>
                  </TableCell>
                </TableRow>
                {open[r.employeeId] && (
                  <TableRow className="bg-secondary/30">
                    <TableCell colSpan={8} className="text-xs space-y-2">
                      {building && (
                        <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-amber-800">
                          ℹ️ <strong>Nota en construcción:</strong> se actualiza cada día/turno. Va por {r.finalizados} de {min} turnos finalizados; al llegar a {min} la semana queda completa. Si faltan turnos al cierre, el GT revisa si es justificado (Ausencias) y define la nota final.
                        </div>
                      )}
                      {state === "nodata" && (
                        <div className="rounded-md border border-border bg-muted/40 px-2 py-1 text-muted-foreground">
                          Sin marcajes registrados en esta semana.
                        </div>
                      )}
                      {r.detalle.length === 0 ? (
                        <span className="text-muted-foreground">Sin entradas registradas esta semana.</span>
                      ) : (
                        <div className="flex flex-wrap gap-2 py-1">
                          {r.detalle.map((d, i) => (
                            <span
                              key={i}
                              className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 ${d.tarde ? "bg-red-50 border-red-200 text-red-800" : "bg-emerald-50 border-emerald-200 text-emerald-800"}`}
                            >
                              {fmtDM(d.date)} {d.turno} · {d.hora}
                              {d.tarde ? ` (+${d.atraso}m tarde)` : " ✓"}
                            </span>
                          ))}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        <strong>Semana Sáb→Vie</strong> (cierra el sábado de madrugada, sin partir el turno nocturno). <strong>La nota se construye día a día</strong>: cada turno marcado actualiza Puntualidad y Marcaje al instante. Aparece <em>"En construcción"</em> mientras la semana avanza y queda <strong>completa</strong> al llegar a 4 turnos (Productos) o 6 (MBK). Un turno en curso (sin salida aún) no cuenta como olvido hasta pasadas 14h.{" "}
        <strong>Puntualidad</strong>: incidencia = llegada &gt;5 min después del inicio (Productos AM 6:00 / PM 18:00; MBK AM 6:00 / PM 14:00).{" "}
        <strong>Marcaje correcto</strong>: olvidos = turnos sin par entrada/salida (los marcajes duplicados &lt;10 min no cuentan); ajustes = marcajes forzados por un supervisor. Nota sugerida 1-5; tomala como referencia y ajustá si hay justificación.{" "}
        <strong>Avance</strong> = % de turnos finalizados sobre los esperados del corte (4 Productos / 6 MBK); ej. 2 de 4 = 50%. Llega a 100% al cumplir el mínimo para calificar. Navegá con ‹ › a la <strong>semana en curso</strong> para verlo subir día a día.
      </p>
    </div>
  );
}

// =====================================================================
// HORARIO (solo lectura): quién marcó, por turno AM/PM y área
// =====================================================================
function addDaysISO(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function fmtDM(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
}

const SCHEDULE_ROW_STYLES: Record<string, { label: string; chip: string }> = {
  PROD_AM: { label: "text-amber-700", chip: "bg-amber-100 text-amber-900 border-amber-200" },
  PROD_PM: { label: "text-blue-700", chip: "bg-blue-100 text-blue-900 border-blue-200" },
  MBK_AM: { label: "text-orange-700", chip: "bg-orange-100 text-orange-900 border-orange-200" },
  MBK_PM: { label: "text-sky-700", chip: "bg-sky-100 text-sky-900 border-sky-200" },
  GT_AM: { label: "text-indigo-700", chip: "bg-indigo-100 text-indigo-900 border-indigo-200" },
  GT_PM: { label: "text-violet-700", chip: "bg-violet-100 text-violet-900 border-violet-200" },
  LIMP_AM: { label: "text-teal-700", chip: "bg-teal-100 text-teal-900 border-teal-200" },
  LIMP_PM: { label: "text-emerald-700", chip: "bg-emerald-100 text-emerald-900 border-emerald-200" },
  SEG_AM: { label: "text-rose-700", chip: "bg-rose-100 text-rose-900 border-rose-200" },
  SEG_PM: { label: "text-red-700", chip: "bg-red-100 text-red-900 border-red-200" },
  TERC_AM: { label: "text-purple-700", chip: "bg-purple-100 text-purple-900 border-purple-200" },
  TERC_PM: { label: "text-fuchsia-700", chip: "bg-fuchsia-100 text-fuchsia-900 border-fuchsia-200" },
};

// Colores concretos (hex) para el PDF del horario, equivalentes a los chips de la
// pantalla (SCHEDULE_ROW_STYLES), para que el documento descargado se vea igual.
const SCHED_PRINT_COLORS: Record<string, { label: string; bg: string; text: string; border: string }> = {
  PROD_AM: { label: "#b45309", bg: "#fef3c7", text: "#78350f", border: "#fde68a" },
  PROD_PM: { label: "#1d4ed8", bg: "#dbeafe", text: "#1e3a8a", border: "#bfdbfe" },
  MBK_AM: { label: "#c2410c", bg: "#ffedd5", text: "#7c2d12", border: "#fed7aa" },
  MBK_PM: { label: "#0369a1", bg: "#e0f2fe", text: "#0c4a6e", border: "#bae6fd" },
  GT_AM: { label: "#4338ca", bg: "#e0e7ff", text: "#312e81", border: "#c7d2fe" },
  GT_PM: { label: "#6d28d9", bg: "#ede9fe", text: "#4c1d95", border: "#ddd6fe" },
  LIMP_AM: { label: "#0f766e", bg: "#ccfbf1", text: "#134e4a", border: "#99f6e4" },
  LIMP_PM: { label: "#047857", bg: "#d1fae5", text: "#064e3b", border: "#a7f3d0" },
  SEG_AM: { label: "#be123c", bg: "#ffe4e6", text: "#881337", border: "#fecdd3" },
  SEG_PM: { label: "#b91c1c", bg: "#fee2e2", text: "#7f1d1d", border: "#fecaca" },
};

// ── Impresión del horario (documento para descargar / imprimir a PDF) ──
function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
// Escribe el documento en una ventana YA abierta (se abre sincrónicamente en el
// gesto del usuario, antes del await, para que el bloqueador de popups no la corte).
function openPrintDoc(win: Window, title: string, innerHtml: string) {
  const css = `
    *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:24px}
    h1{font-size:18px;margin:0 0 2px;color:#E8622A}
    .sub{color:#555;font-size:12px;margin:0 0 16px}
    h3{font-size:14px;margin:18px 0 6px;border-bottom:2px solid #E8622A;padding-bottom:2px}
    h4{font-size:12px;margin:10px 0 4px;color:#20303B}
    table{border-collapse:collapse;width:100%;font-size:11px;margin-bottom:8px}
    th,td{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top}
    th{background:#f2f2f2}
    .rl{font-weight:bold;white-space:nowrap}
    .dn{font-weight:normal;color:#888}
    .chip{display:block;border:1px solid #ccc;border-radius:6px;padding:2px 6px;margin:2px 0;font-size:10px;white-space:nowrap}
    .dash{color:#aaa}
    .pb{page-break-after:always}
    @media print{body{margin:0}}
  `;
  win.document.open();
  win.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escHtml(title)}</title><style>${css}</style></head>` +
    `<body>${innerHtml}<script>window.onload=function(){setTimeout(function(){window.print()},350)}<\/script></body></html>`,
  );
  win.document.close();
}
type PrintDay = { date: string; label: string; dayNum: string };
type PrintRow = { key: string; label: string; cells: Array<{ date: string; people: Array<{ id: string; name: string; cover: boolean; home: string | null }> }> };
type PrintTercShift = { name: string; entrada: string | null; salida: string | null; horas: number | null };
type PrintTercDay = { date: string; label: string; dayNum: string; shifts: PrintTercShift[] };
type PrintWeek = { weekStart: string; weekEnd: string; days: PrintDay[]; rows: PrintRow[]; terc: PrintTercDay[] };
type SchedulePrintData = { store: { code: string; name: string }; weekStart: string; weekEnd: string; weeks: PrintWeek[] };

function buildSchedulePrintHtml(data: SchedulePrintData): string {
  const neutral = { label: "#111", bg: "#f2f2f2", text: "#111", border: "#ccc" };
  const week = (w: PrintWeek) => {
    const heads = w.days.map((d) => `<th>${d.label}<br><span class="dn">${d.dayNum}</span></th>`).join("");
    const body = w.rows.map((r) => {
      const col = SCHED_PRINT_COLORS[r.key] ?? neutral;
      const cells = r.cells.map((c) =>
        `<td>${c.people.length
          ? c.people.map((p) => `<span class="chip" style="background:${col.bg};color:${col.text};border-color:${col.border}${p.cover ? ";border-style:dashed" : ""}">${escHtml(p.name)}${p.cover ? ` · cob. ${escHtml(p.home ?? "otra")}` : ""}</span>`).join("")
          : '<span class="dash">—</span>'}</td>`,
      ).join("");
      return `<tr><td class="rl" style="color:${col.label}">${escHtml(r.label)}</td>${cells}</tr>`;
    }).join("");
    return `<h3>Semana del ${fmtDM(w.weekStart)} al ${fmtDM(w.weekEnd)}</h3>` +
      `<table><thead><tr><th class="rl">Turno</th>${heads}</tr></thead><tbody>${body}</tbody></table>`;
  };
  return `<h1>Horario — ${escHtml(data.store.code)} ${escHtml(data.store.name)}</h1>` +
    `<p class="sub">Del ${fmtDM(data.weekStart)} al ${fmtDM(data.weekEnd)} · Productos, MBK, Gerente de Tienda, Limpieza y Seguridad interna. ` +
    `Refleja quién marcó ENTRADA por turno (hora de Nicaragua).</p>` +
    data.weeks.map((w, i) => week(w) + (i < data.weeks.length - 1 ? '<div class="pb"></div>' : "")).join("");
}
function buildTercPrintHtml(data: SchedulePrintData): string {
  const hhmm = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - 6 * 3600 * 1000).toISOString().slice(11, 16) : "—");
  const week = (w: PrintWeek) => {
    const blocks = w.terc.map((d) => {
      const body = d.shifts.length
        ? d.shifts.map((s) =>
            `<tr><td>${escHtml(s.name)}</td><td>${hhmm(s.entrada)}</td><td>${hhmm(s.salida)}</td>` +
            `<td>${s.horas != null ? s.horas : "—"}</td>` +
            `<td>${s.salida ? "OK" : s.entrada ? "Sin salida" : "Sin entrada"}</td></tr>`,
          ).join("")
        : '<tr><td colspan="5" class="dash">Sin marcaje registrado</td></tr>';
      return `<div><h4>${d.label} ${d.dayNum}</h4>` +
        `<table><thead><tr><th>Guarda</th><th>Entrada</th><th>Salida</th><th>Horas</th><th>Estado</th></tr></thead><tbody>${body}</tbody></table></div>`;
    }).join("");
    return `<h3>Semana del ${fmtDM(w.weekStart)} al ${fmtDM(w.weekEnd)}</h3>${blocks}`;
  };
  return `<h1>Seguridad Tercerizada — ${escHtml(data.store.code)} ${escHtml(data.store.name)}</h1>` +
    `<p class="sub">Asistencia y cumplimiento del guarda tercerizado (entrada/salida y horas por día). ` +
    `Del ${fmtDM(data.weekStart)} al ${fmtDM(data.weekEnd)}.</p>` +
    data.weeks.map((w, i) => week(w) + (i < data.weeks.length - 1 ? '<div class="pb"></div>' : "")).join("");
}

function WeeklySchedulePanel() {
  const scheduleFn = useServerFn(getWeeklySchedule);
  const printFn = useServerFn(getSchedulePrint);
  const storesFn = useServerFn(listStores);
  const { data: stores, isLoading: storesLoading } = useQuery({ queryKey: ["stores"], queryFn: () => storesFn() });
  const storeList = stores ?? [];
  const [storeId, setStoreId] = useState<string>("");
  const [weekStart, setWeekStart] = useState<string | undefined>(undefined);
  const [weeks, setWeeks] = useState(1); // semanas a imprimir (hacia atrás desde la mostrada)
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    if (!storeId && storeList.length > 0) setStoreId(storeList[0].id);
  }, [storeList, storeId]);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["schedule", storeId, weekStart ?? "current"],
    queryFn: () => scheduleFn({ data: { storeId, ...(weekStart ? { weekStart } : {}) } }),
    enabled: !!storeId,
  });

  // Imprime N semanas TERMINANDO en la semana mostrada (las últimas N semanas).
  const doPrint = async (kind: "general" | "terc") => {
    if (!storeId || !data) return;
    // Abrir la ventana YA (en el gesto de clic) para que no la bloquee el navegador;
    // se llena tras el await con el documento generado.
    const win = window.open("", "_blank");
    if (!win) {
      toast.error("Habilita las ventanas emergentes para poder imprimir/descargar.");
      return;
    }
    win.document.write('<!doctype html><meta charset="utf-8"><title>Generando…</title><body style="font-family:Arial;padding:24px;color:#555">Generando documento…</body>');
    setPrinting(true);
    try {
      const startWeek = addDaysISO(data.weekStart, -(weeks - 1) * 7); // lunes de la 1ª semana
      const res = await printFn({ data: { storeId, weeks, weekStart: startWeek } });
      if (kind === "general") openPrintDoc(win, `Horario ${res.store.code}`, buildSchedulePrintHtml(res));
      else openPrintDoc(win, `Tercerizados ${res.store.code}`, buildTercPrintHtml(res));
    } catch (e: unknown) {
      win.close();
      toast.error(e instanceof Error ? e.message : "Error al generar el documento");
    } finally {
      setPrinting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-foreground">Horario — quién marcó</h2>
          <p className="text-sm text-muted-foreground">
            Se llena solo con los marcajes reales (entrada), por turno AM/PM y área.
          </p>
        </div>
        <Select value={storeId} onValueChange={setStoreId}>
          <SelectTrigger className="w-60"><SelectValue placeholder="Selecciona tienda…" /></SelectTrigger>
          <SelectContent>
            {storeList.map((s) => (
              <SelectItem key={s.id} value={s.id}>{s.code} · {s.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="outline" size="sm" disabled={!data} onClick={() => data && setWeekStart(addDaysISO(data.weekStart, -7))}>
          ← Semana anterior
        </Button>
        <div className="text-sm text-muted-foreground">
          {data ? `Semana del ${fmtDM(data.weekStart)} al ${fmtDM(data.weekEnd)}` : "…"}
          {isFetching ? " · actualizando" : ""}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setWeekStart(undefined)}>Esta semana</Button>
          <Button variant="outline" size="sm" disabled={!data} onClick={() => data && setWeekStart(addDaysISO(data.weekStart, 7))}>
            Semana siguiente →
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2">
        <span className="text-sm font-medium text-foreground">Descargar / imprimir:</span>
        <Select value={String(weeks)} onValueChange={(v) => setWeeks(Number(v))}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="1">1 semana</SelectItem>
            <SelectItem value="2">2 semanas</SelectItem>
            <SelectItem value="3">3 semanas</SelectItem>
            <SelectItem value="4">4 semanas</SelectItem>
            <SelectItem value="6">6 semanas</SelectItem>
            <SelectItem value="8">8 semanas</SelectItem>
          </SelectContent>
        </Select>
        <Button
          size="sm"
          className="bg-accent text-accent-foreground hover:bg-accent/90"
          disabled={!storeId || !data || printing}
          onClick={() => doPrint("general")}
          title="Horario de Productos, MBK, GT, Limpieza y Seguridad interna"
        >
          <Download className="h-4 w-4 mr-1" /> {printing ? "Generando…" : "Horario general"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!storeId || !data || printing}
          onClick={() => doPrint("terc")}
          title="Asistencia y cumplimiento del guarda tercerizado (entrada/salida y horas)"
        >
          <ShieldCheck className="h-4 w-4 mr-1" /> Seguridad tercerizada
        </Button>
        <span className="text-xs text-muted-foreground w-full sm:w-auto">Toma las últimas N semanas hasta la mostrada. Se abre una vista lista para imprimir o guardar como PDF.</span>
      </div>

      <div className="bg-card rounded-2xl border border-border overflow-x-auto">
        {isLoading || !data ? (
          <div className="text-center py-12 text-muted-foreground">
            {storeId ? "Cargando horario…" : storesLoading ? "Cargando…" : "No hay tiendas disponibles."}
          </div>
        ) : (
          <table className="w-full border-collapse text-sm min-w-[860px]">
            <thead>
              <tr className="bg-secondary/50">
                <th className="text-left p-3 font-semibold text-foreground w-48">Turno</th>
                {data.days.map((d) => (
                  <th key={d.date} className="text-left p-3 font-semibold text-foreground">
                    <div>{d.label}</div>
                    <div className="text-xs font-normal text-muted-foreground">{d.dayNum}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => {
                const st = SCHEDULE_ROW_STYLES[row.key] ?? { label: "", chip: "bg-secondary border-border" };
                return (
                  <tr key={row.key} className="border-t border-border align-top">
                    <td className={`p-3 font-semibold ${st.label}`}>{row.label}</td>
                    {row.cells.map((cell) => (
                      <td key={cell.date} className="p-2 align-top">
                        {cell.people.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <div className="flex flex-col gap-1">
                            {cell.people.map((p) => (
                              <span
                                key={p.id}
                                className={`text-xs rounded-md border px-2 py-1 ${st.chip} ${p.cover ? "border-dashed font-medium" : ""}`}
                                title={p.cover ? `Cobertura — agente de ${p.home ?? "otra tienda"}` : undefined}
                              >
                                {p.name}
                                {p.cover && <span className="ml-1 opacity-80">· cob. {p.home ?? "otra"}</span>}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        El turno AM/PM se calcula por la hora de <strong>entrada</strong> (hora de Nicaragua). Categorías: Productos (cajeros),
        MBK, Gerente de Tienda, Limpieza, Seguridad interna y Seguridad tercerizada; los polivalentes se ubican según el área que
        marcaron. Este horario es de solo lectura (refleja marcajes reales), no es planificación.
      </p>
    </div>
  );
}

function DashboardPanel() {
  const metricsFn = useServerFn(getDashboardMetrics);
  const summaryFn = useServerFn(getEmployeeSummary);
  const exportFn = useServerFn(exportAttendance);
  const filter = useStoreFilter();
  const [days, setDays] = useState(7);
  const [exporting, setExporting] = useState(false);
  const [openEmployee, setOpenEmployee] = useState<{ id: string; name: string } | null>(null);
  // Rango de fechas para la DESCARGA (independiente del histórico del dashboard).
  // Por defecto, los últimos 7 días inclusive (hoy + 6 días atrás, hora Nicaragua).
  const [expFrom, setExpFrom] = useState(() => new Date(Date.now() - 6 * 3600 * 1000 - 6 * 24 * 3600 * 1000).toISOString().slice(0, 10));
  const [expTo, setExpTo] = useState(() => todayNI());

  const doExport = async () => {
    if (!expFrom || !expTo) {
      toast.error("Elige el rango de fechas (Desde y Hasta).");
      return;
    }
    if (expFrom > expTo) {
      toast.error("La fecha 'Desde' no puede ser mayor que 'Hasta'.");
      return;
    }
    setExporting(true);
    try {
      const exportArgs: { days: number; from?: string; to?: string; storeId?: string; zoneId?: string } = { days, from: expFrom, to: expTo };
      if (filter.storeId !== "all") exportArgs.storeId = filter.storeId;
      else if (filter.zoneId !== "all") exportArgs.zoneId = filter.zoneId;
      const rows = await exportFn({ data: exportArgs });
      const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      // Cédula entre el código (usuario) y el nombre del colaborador.
      const header = ["Fecha", "Hora", "Codigo", "Cedula", "Nombre", "Rol", "Tienda", "Tipo", "UbicacionValida"];
      const lines = [header.join(",")].concat(
        rows.map((r) => [r.fecha, r.hora, r.codigo, esc(r.cedula), esc(r.nombre), r.rol, esc(r.tienda), r.tipo, r.ubicacion_valida].join(",")),
      );
      const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `marcajes_${expFrom}_a_${expTo}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      if (rows.length === 0) toast.message("No hay marcajes en el periodo seleccionado.");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error al exportar");
    } finally {
      setExporting(false);
    }
  };

  const metricArgs: { days: number; storeId?: string; zoneId?: string } = { days };
  if (filter.storeId !== "all") metricArgs.storeId = filter.storeId;
  else if (filter.zoneId !== "all") metricArgs.zoneId = filter.zoneId;
  const { data: m, isLoading } = useQuery({
    queryKey: ["dashboard", days, filter.zoneId, filter.storeId],
    queryFn: () => metricsFn({ data: metricArgs }),
    refetchInterval: 20_000,
  });
  const { data: summary } = useQuery({
    queryKey: ["empSummary", days],
    queryFn: () => summaryFn({ data: { days } }),
  });
  const summaryRows = (summary ?? []).filter((e) => filter.matches(e.store_id));
  // Agrupar la asistencia por tipo (rol) con subtotal de horas por tipo.
  const summaryGroups = useMemo(() => {
    const ORDER = ["cajero", "agente_mbk", "gerente", "gerente_zona", "personal_limpieza", "seguridad_interna", "seguridad", "seguridad_tercerizada"];
    const oi = (r: string) => { const i = ORDER.indexOf(r); return i < 0 ? 999 : i; };
    const g = new Map<string, typeof summaryRows>();
    for (const r of summaryRows) { const arr = g.get(r.role) ?? []; arr.push(r); g.set(r.role, arr); }
    return [...g.entries()].sort((a, b) => oi(a[0]) - oi(b[0])).map(([role, list]) => ({
      role,
      list: [...list].sort((x, y) => y.hours - x.hours),
      hours: Math.round(list.reduce((s, x) => s + x.hours, 0) * 10) / 10,
    }));
  }, [summaryRows]);

  if (isLoading || !m) {
    return <div className="text-center py-12 text-muted-foreground">Cargando dashboard…</div>;
  }

  const isSuper = m.scope.isAdmin || m.scope.isOperations;
  const isZone = m.scope.isZoneAdmin && !isSuper;
  const isStore = !isSuper && !isZone;
  const levelTitle = isSuper
    ? "Resumen ejecutivo · General"
    : isZone ? "Resumen ejecutivo · Mi zona" : "Resumen ejecutivo · Mi tienda";

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-foreground">{levelTitle}</h2>
          <p className="text-sm text-muted-foreground">
            Hoy · histórico {days} días · se actualiza cada 20 s
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {filter.bar}
          <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border px-2 py-1">
            <span className="text-xs text-muted-foreground shrink-0">Descarga:</span>
            <Input
              type="date"
              value={expFrom}
              max={expTo || undefined}
              onChange={(e) => setExpFrom(e.target.value)}
              className="h-8 w-[7.5rem]"
              title="Desde"
            />
            <span className="text-xs text-muted-foreground">a</span>
            <Input
              type="date"
              value={expTo}
              min={expFrom || undefined}
              onChange={(e) => setExpTo(e.target.value)}
              className="h-8 w-[7.5rem]"
              title="Hasta"
            />
            <Button variant="outline" size="sm" onClick={doExport} disabled={exporting} title="Descargar los marcajes del rango elegido (Excel/CSV)">
              <Download className="h-4 w-4 mr-1" /> {exporting ? "Generando…" : "Descargar"}
            </Button>
          </div>
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Hoy</SelectItem>
              <SelectItem value="7">7 días</SelectItem>
              <SelectItem value="30">30 días</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {isStore ? (
          <>
            <KPI label="Dotación (agentes)" value={`${m.dotacion_today?.real ?? 0}/${m.dotacion_today?.plan ?? 0}`} sub={`${m.dotacion_today?.pct ?? 0}% del plan`} accent="entry" />
            <KPI label="Personas en el turno" value={m.personas_turno?.total ?? 0} sub="logeadas en el corte" accent="muted" />
            <KPI label="Dentro ahora" value={m.inside_now} accent="primary" />
            <KPI label="Marcaron tarde hoy" value={m.late_today?.length ?? 0} sub="entrada fuera de hora" accent="exit" />
          </>
        ) : (
          <>
            <KPI label={isSuper ? "Tiendas" : "Tiendas (mi zona)"} value={m.stores_count} accent="primary" />
            <KPI label="Dotación (agentes)" value={`${m.dotacion_today?.real ?? 0}/${m.dotacion_today?.plan ?? 0}`} sub={`${m.dotacion_today?.pct ?? 0}% del plan`} accent="entry" />
            <KPI label="Personas en el turno" value={m.personas_turno?.total ?? 0} sub="logeadas en el corte" accent="muted" />
            <KPI label="Marcaron tarde hoy" value={m.late_today?.length ?? 0} sub="entrada fuera de hora" accent="exit" />
          </>
        )}
      </div>

      <DotacionStoreTable rows={m.by_store} prodCorte={m.prod_corte ?? "AM"} mbkCorte={m.mbk_corte ?? "AM"} />

      <StaffingBudgetCard zoneId={filter.zoneId} storeId={filter.storeId} />

      {m.stuck_open.length > 0 && (
        <div className="bg-card border border-[oklch(0.7_0.18_50)] rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-2 text-[oklch(0.65_0.18_50)] font-semibold">
            <AlertTriangle className="h-4 w-4" />
            Alertas — sesiones abiertas hace más de 10 h
          </div>
          <ul className="text-sm space-y-1">
            {m.stuck_open.map((s) => (
              <li key={s.id} className="text-foreground">
                <span className="font-mono">{s.employee_code}</span> · {s.full_name}
                <span className="text-muted-foreground"> — desde {new Date(s.since).toLocaleString("es-MX")}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {isStore && (
        <div className="grid lg:grid-cols-2 gap-4">
          <TurnoTypeCard personas={m.personas_turno} />
          <InsideCard inside={m.inside} />
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-4">
        <LateTodayCard rows={m.late_today} />
        <OvertimeCard rows={m.overtime_today} />
      </div>

      <StoreEntryHoursCard storeId={filter.storeId} zoneId={filter.zoneId} />

      {/* Marcaje de gerentes: el GZ ve a sus GT; la Administración ve además el
          recorrido de cada GZ. El GT no lo ve. */}
      {(isZone || isSuper) && <ManagerMarksCards storeId={filter.storeId} zoneId={filter.zoneId} />}

      {isZone && (
        <div className="grid lg:grid-cols-2 gap-4">
          <StoreExecTable title="Por tienda (mi zona)" subtitle="Presentes / colaboradores y actividad" rows={m.by_store} />
          <div className="bg-card rounded-2xl border border-border overflow-hidden">
            <div className="p-4 border-b border-border">
              <h3 className="font-semibold text-foreground">Por tipo de colaborador</h3>
              <p className="text-xs text-muted-foreground">Presentes hoy / total</p>
            </div>
            <RoleTable rows={m.by_role} />
          </div>
        </div>
      )}

      {isSuper && (
        <>
          <ZoneExecTable rows={m.by_zone} />
          <div className="grid lg:grid-cols-2 gap-4">
            <StoreExecTable title="Por tienda (ranking)" subtitle="Top 15 por actividad" rows={m.by_store.slice(0, 15)} />
            <div className="bg-card rounded-2xl border border-border overflow-hidden">
              <div className="p-4 border-b border-border">
                <h3 className="font-semibold text-foreground">Por tipo de colaborador</h3>
                <p className="text-xs text-muted-foreground">Presentes hoy / total</p>
              </div>
              <RoleTable rows={m.by_role} />
            </div>
          </div>
        </>
      )}

      <div className="bg-card rounded-2xl border border-border overflow-hidden">
        <div className="p-4 border-b border-border">
          <h3 className="font-semibold text-foreground">Asistencia por colaborador</h3>
          <p className="text-xs text-muted-foreground">Horas trabajadas por persona, agrupado por tipo · clic en una fila para ver el detalle diario</p>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="bg-secondary/50">
              <TableHead>Colaborador</TableHead>
              <TableHead className="text-right">Días</TableHead>
              <TableHead className="text-right">Horas</TableHead>
              <TableHead className="text-right">Marcajes</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summaryRows.length === 0 ? (
              <TableRow><TableCell colSpan={5} className="text-center py-6 text-muted-foreground">Sin datos en el periodo.</TableCell></TableRow>
            ) : summaryGroups.map((g) => (
              <Fragment key={g.role}>
                <TableRow className="bg-secondary/40 hover:bg-secondary/40">
                  <TableCell colSpan={5} className="text-xs font-semibold text-foreground uppercase tracking-wide">
                    {ROLE_LABELS[g.role as EmployeeRole] ?? g.role}
                  </TableCell>
                </TableRow>
                {g.list.map((e) => (
                  <TableRow key={e.id} className="cursor-pointer hover:bg-secondary/40" onClick={() => setOpenEmployee({ id: e.id, name: e.full_name })}>
                    <TableCell>
                      <div className="font-medium text-foreground">{e.full_name}</div>
                      <div className="text-xs text-muted-foreground font-mono">{e.employee_code}</div>
                    </TableCell>
                    <TableCell className="text-right">{e.days_present}</TableCell>
                    <TableCell className="text-right font-medium">{e.hours}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{e.marks}</TableCell>
                    <TableCell className="text-right"><ChevronRight className="h-4 w-4 text-muted-foreground inline" /></TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell className="text-xs text-muted-foreground pl-6">Subtotal {ROLE_LABELS[g.role as EmployeeRole] ?? g.role}</TableCell>
                  <TableCell></TableCell>
                  <TableCell className="text-right font-semibold">{g.hours} h</TableCell>
                  <TableCell colSpan={2}></TableCell>
                </TableRow>
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>

      {openEmployee && (
        <EmployeeWeeklyModal
          employeeId={openEmployee.id}
          employeeName={openEmployee.name}
          onClose={() => setOpenEmployee(null)}
        />
      )}
    </div>
  );
}

// =====================================================================
// CREAR HORARIO — planificación semanal (motor en servidor)
// =====================================================================
function mondayISOf(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
type SchedAssign = { id: string; role: "CAJA" | "APOYO"; supportFrom?: string | null; contingency?: boolean; exception?: string; intercambio?: boolean; override?: boolean };
const emptySchedGrid = (): SchedGrid => {
  const g = {} as SchedGrid;
  SCH_SHIFT_KEYS.forEach((k) => { g[k] = Array.from({ length: 7 }, () => [] as SchedAssign[]); });
  return g;
};
const cloneSchedGrid = (g: SchedGrid): SchedGrid => JSON.parse(JSON.stringify(g));
/** Nombre compacto para la rejilla (primer nombre + último apellido). El completo va en
 * el title y en la impresión, para que las celdas no ensanchen la tabla. */
const shortName = (full: string) => {
  const p = String(full || "").trim().split(/\s+/);
  return p.length <= 2 ? full : `${p[0]} ${p[p.length - 1]}`;
};
type AdhResult =
  | { found: false; weekStart: string }
  | {
      found: true; weekStart: string; status: string;
      totals: { planned: number; present: number; absent: number; late: number; extra: number; adherencePct: number; punctualityPct: number };
      byEmployee: Array<{ id: string; name: string; planned: number; present: number; absent: number; late: number; extra: number }>;
      noShows: Array<{ name: string; day: string; shift: string }>;
      lates: Array<{ name: string; day: string; shift: string; enteredAt: string; expected: string; lateMin: number }>;
      extras: Array<{ name: string; day: string; enteredAt: string }>;
    };

function SchedulePlannerPanel() {
  const ctxFn = useServerFn(getScheduleContext);
  const genFn = useServerFn(generateSchedule);
  const saveFn = useServerFn(saveSchedule);
  const attrsFn = useServerFn(setEmployeeScheduleAttrs);
  const adhFn = useServerFn(getScheduleAdherence);
  const storesFn = useServerFn(listStores);
  const { data: storesData } = useQuery({ queryKey: ["stores"], queryFn: () => storesFn() });
  const stores = storesData ?? [];

  const [storeId, setStoreId] = useState("");
  const [weekStart, setWeekStart] = useState(() => mondayISOf(todayNI()));
  const [store, setStore] = useState<{ code: string; name: string; prodHC: number; mbkHC: number; prodBudget?: number | null; mbkBudget?: number | null } | null>(null);
  const [team, setTeam] = useState<SchedPerson[]>([]);
  const [coverage, setCoverage] = useState<SchedCoverage | null>(null);
  const [schedule, setSchedule] = useState<SchedGrid | null>(null);
  const [alerts, setAlerts] = useState<SchedAlert[]>([]);
  const [savedStatus, setSavedStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"" | "gen" | "save" | "approve">("");
  const [hasPrior, setHasPrior] = useState(true);      // ¿hay horario aprobado previo? (si no, pedir "cerró dom. pasado")
  const [domPrevIds, setDomPrevIds] = useState<string[]>([]); // quién cerró domingo noche pasado (semilla, primer horario)
  const [showRules, setShowRules] = useState(false);   // reglas rotas colapsadas por defecto (verlas si se quieren)
  const [selEmp, setSelEmp] = useState<string | null>(null); // agente resaltado: ver toda su semana de un vistazo
  const [adh, setAdh] = useState<AdhResult | null>(null); // adherencia plan↔marcaje (Fase 2)
  const [adhBusy, setAdhBusy] = useState(false);

  useEffect(() => { if (!storeId && stores.length) setStoreId(stores[0].id); }, [stores, storeId]);

  const loadCtx = useCallback(async () => {
    if (!storeId || !weekStart) return;
    setLoading(true);
    try {
      const c = await ctxFn({ data: { storeId, weekStart } });
      setStore(c.store);
      const teamNow = c.team as SchedPerson[];
      setTeam(teamNow);
      if (c.existing) {
        const cov = c.existing.coverage as unknown as SchedCoverage;
        setCoverage(cov);
        const g = emptySchedGrid();
        for (const s of (c.existing.schedule_shifts ?? []) as Array<{ employee_id: string; day_index: number; shift_key: string; role: string; flags: Record<string, unknown> }>) {
          const k = s.shift_key as SchedShiftKey;
          if (g[k] && s.day_index >= 0 && s.day_index <= 6) g[k][s.day_index].push({ id: s.employee_id, role: s.role === "APOYO" ? "APOYO" : "CAJA", ...(s.flags || {}) });
        }
        setSchedule(g); setSavedStatus(c.existing.status);
        // Validar el plan cargado (reglas sin historial) — no dejar el gate en verde con un plan inválido.
        try { setAlerts(schedValidate({ people: teamNow, coverage: cov, weekStart, prodHC: c.store.prodHC, mbkHC: c.store.mbkHC }, g)); } catch { setAlerts([]); }
      } else { setCoverage(c.suggested as unknown as SchedCoverage); setSchedule(null); setSavedStatus(null); setAlerts([]); }
      setHasPrior(!!c.hasPriorApproved); setDomPrevIds([]); setShowRules(false); setAdh(null);
    } catch (e) { toast.error(e instanceof Error ? e.message : "No se pudo cargar"); } finally { setLoading(false); }
    // ctxFn (useServerFn) se referencia por closure; NO va en deps para no reejecutar en cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, weekStart]);
  useEffect(() => { loadCtx(); }, [loadCtx]);

  const gridToAssignments = (g: SchedGrid) => {
    const out: Array<{ employee_id: string; day_index: number; shift_key: SchedShiftKey; role: "CAJA" | "APOYO"; flags: Record<string, unknown> }> = [];
    SCH_SHIFT_KEYS.forEach((k) => g[k].forEach((arr, d) => arr.forEach((it) => {
      const { id, role, ...flags } = it as SchedAssign;
      out.push({ employee_id: id, day_index: d, shift_key: k, role: role === "APOYO" ? "APOYO" : "CAJA", flags });
    })));
    return out;
  };
  const nameOf = (id: string) => team.find((p) => p.id === id)?.nombre ?? "—";

  const doGenerate = async () => {
    if (!coverage) return;
    setBusy("gen");
    try { const r = await genFn({ data: { storeId, weekStart, coverage: coverage as unknown as never, domPrev: hasPrior ? [] : domPrevIds } }); setSchedule(r.schedule as unknown as SchedGrid); setAlerts(r.alerts as SchedAlert[]); const reds = r.alerts.filter((a) => a.level === "bad").length; toast.success(`Horario generado · ${(r.combos ?? 0).toLocaleString()} combinaciones probadas · ${reds} regla(s) roja(s)`); }
    catch (e) { toast.error(e instanceof Error ? e.message : "No se pudo generar"); }
    finally { setBusy(""); }
  };

  // Revalida el horario editado a mano con las MISMAS reglas del motor (cliente).
  const revalidate = (g: SchedGrid) => {
    if (!coverage || !store) return;
    try { setAlerts(schedValidate({ people: team, coverage, weekStart, prodHC: store.prodHC, mbkHC: store.mbkHC }, g)); } catch { /* noop */ }
  };
  const removeFromCell = (k: SchedShiftKey, d: number, idx: number) => {
    if (!schedule) return;
    const g = cloneSchedGrid(schedule); g[k][d].splice(idx, 1); setSchedule(g); revalidate(g);
  };
  // El GT decide: puede asignar a CUALQUIER agente. Si eso rompe el doble turno (24h) o el
  // cruce de área, se le pide confirmación y el turno queda marcado como autorizado por él
  // (esas dos reglas bajan de roja a advertencia; las demás siguen bloqueando).
  const addToCell = (k: SchedShiftKey, d: number, empId: string) => {
    if (!empId || !schedule) return;
    const p = team.find((x) => x.id === empId);
    if (!p) return;
    if (schedule[k][d].some((a) => a.id === empId)) return; // ya está en esa celda
    const shiftArea = SCH_SHIFT_DEF[k].area;
    const yaTiene = SCH_SHIFT_KEYS.some((sk) => schedule[sk][d].some((a) => a.id === empId));
    const cruceValido = shiftArea === "MBK" && p.area === "PRODUCTOS" && !!p.mbkQ;
    const cruceArea = p.area !== shiftArea && !cruceValido;
    const avisos: string[] = [];
    if (yaTiene) avisos.push(`• ${p.nombre} ya tiene turno el ${SCH_DAYS[d]}: quedaría con DOBLE TURNO (24 h).`);
    if (cruceArea) avisos.push(`• ${p.nombre} es de ${p.area === "MBK" ? "MBK" : "Productos"} y este turno es de ${shiftArea === "MBK" ? "MBK" : "Productos"}.`);
    if (avisos.length && !window.confirm(`${avisos.join("\n")}\n\n¿Asignarlo de todas formas? Quedará registrado como autorizado por ti.`)) return;
    const g = cloneSchedGrid(schedule);
    const assign: SchedAssign = { id: empId, role: p.puesto === "APOYO" ? "APOYO" : "CAJA" };
    if (shiftArea === "MBK" && p.area === "PRODUCTOS") assign.supportFrom = "PRODUCTOS";
    if (avisos.length) assign.override = true;
    g[k][d].push(assign);
    setSchedule(g); revalidate(g);
  };
  const toggleDomPrev = (id: string) => setDomPrevIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // Imprimir el horario (documento listo para PDF). La ventana se abre en el gesto de clic
  // (sin await) para que el navegador no la bloquee.
  const printSchedule = () => {
    if (!schedule || !store) return;
    const w = window.open("", "_blank");
    if (!w) { toast.error("Permite las ventanas emergentes para poder imprimir."); return; }
    const aprobado = savedStatus === "approved";
    const bg: Record<string, string> = { PROD_AM: "#FEF3C7", PROD_PM: "#DBEAFE", MBK_AM: "#FFEDD5", MBK_PM: "#E0F2FE" };
    const th = SCH_DAYS.map((dd, i) => `<th>${dd}<br><span class="sm">${fmtDM(addDaysISO(weekStart, i))}</span></th>`).join("");
    const filas = SCH_SHIFT_KEYS.map((k) => {
      const tds = schedule[k].map((arr) => {
        const items = arr.map((it) => {
          const a = it as SchedAssign;
          const extra = [a.supportFrom ? "cruzado" : "", a.role === "APOYO" ? "apoyo" : "", a.override ? "autorizado GT" : ""].filter(Boolean).join(", ");
          return `<div>${nameOf(it.id)}${extra ? ` <span class="sm">(${extra})</span>` : ""}</div>`;
        }).join("");
        return `<td>${items || '<span class="sm">—</span>'}</td>`;
      }).join("");
      return `<tr><th class="turno" style="background:${bg[k]}">${SCH_SHIFT_DEF[k].short}</th>${tds}</tr>`;
    }).join("");
    const res = summary.map((p) => `<tr><td>${p.nombre}</td><td>${p.area === "MBK" ? "MBK" : "Productos"}</td><td class="c">${p.turns}</td><td class="c">${p.hours}h / ${p.horasMeta}h</td></tr>`).join("");
    w.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Horario ${store.code} ${fmtDM(weekStart)}</title>
<style>body{font-family:Segoe UI,Arial,sans-serif;color:#20303B;margin:24px}
h1{color:#E8622A;margin:0 0 2px;font-size:20px}.sub{color:#5B6B78;margin:0 0 14px;font-size:13px}
.est{display:inline-block;padding:3px 10px;border-radius:999px;font-weight:700;font-size:12px}
table{border-collapse:collapse;width:100%;font-size:12px;margin-bottom:18px}
th,td{border:1px solid #ccc;padding:6px 8px;vertical-align:top;text-align:left}
th{background:#F4F6F8}.turno{font-weight:700;white-space:nowrap}.sm{font-size:10px;color:#5B6B78}
.c{text-align:center}h2{font-size:14px;margin:14px 0 6px}
@media print{body{margin:10mm}@page{size:landscape}}</style></head><body>
<h1>Horario semanal — ${store.code} ${store.name}</h1>
<p class="sub">Semana ${fmtDM(weekStart)} al ${fmtDM(weekEnd)} · <span class="est" style="background:${aprobado ? "#D1FAE5" : "#FEF3C7"};color:${aprobado ? "#065F46" : "#92400E"}">${aprobado ? "APROBADO" : "BORRADOR — no aprobado"}</span></p>
<table><thead><tr><th>Turno</th>${th}</tr></thead><tbody>${filas}</tbody></table>
<h2>Resumen por colaborador</h2>
<table><thead><tr><th>Colaborador</th><th>Área</th><th class="c">Turnos</th><th class="c">Horas</th></tr></thead><tbody>${res}</tbody></table>
<script>window.onload=function(){window.print()}<\/script></body></html>`);
    w.document.close();
  };
  const loadAdherence = async () => {
    setAdhBusy(true);
    try { setAdh(await adhFn({ data: { storeId, weekStart } }) as AdhResult); }
    catch (e) { toast.error(e instanceof Error ? e.message : "No se pudo cargar la adherencia"); }
    finally { setAdhBusy(false); }
  };
  const doSave = async (status: "draft" | "approved") => {
    if (!coverage || !schedule) { toast.error("Genera el horario primero"); return; }
    setBusy(status === "approved" ? "approve" : "save");
    try { await saveFn({ data: { storeId, weekStart, coverage: coverage as unknown as never, status, assignments: gridToAssignments(schedule) } }); setSavedStatus(status); toast.success(status === "approved" ? "Horario aprobado y guardado" : "Borrador guardado"); }
    catch (e) { toast.error(e instanceof Error ? e.message : "No se pudo guardar"); }
    finally { setBusy(""); }
  };

  const updateCov = (k: SchedShiftKey, d: number, v: number) => setCoverage((c) => (c ? { ...c, [k]: c[k].map((x, i) => (i === d ? Math.max(0, v || 0) : x)) } : c));
  const updateTeamAttr = async (id: string, patch: Partial<SchedPerson>, dbPatch: Record<string, unknown>) => {
    setTeam((t) => t.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    try { await attrsFn({ data: { id, ...dbPatch } }); } catch (e) { toast.error(e instanceof Error ? e.message : "No se guardó"); }
  };

  const weekEnd = addDaysISO(weekStart, 6);
  const covPct = (() => {
    if (!coverage || !schedule) return null;
    let need = 0, have = 0;
    SCH_SHIFT_KEYS.forEach((k) => coverage[k].forEach((req, d) => { need += req; have += Math.min(req, schedule[k][d].filter((a) => (a as SchedAssign).role !== "APOYO").length); }));
    return need ? Math.round((have * 100) / need) : 0;
  })();
  const bad = alerts.filter((a) => a.level === "bad"), warn = alerts.filter((a) => a.level === "warn");
  const summary = team.map((p) => {
    let turns = 0, hours = 0;
    if (schedule) SCH_SHIFT_KEYS.forEach((k) => schedule[k].forEach((arr) => arr.forEach((it) => { if (it.id === p.id) { turns++; hours += (it as SchedAssign).supportFrom === "PRODUCTOS" ? 12 : SCH_SHIFT_DEF[k].hours; } })));
    return { ...p, turns, hours };
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-foreground">Crear horario semanal</h2>
          <p className="text-sm text-muted-foreground">Define tu cobertura, genera el plan y apruébalo. El marcaje valida su cumplimiento.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {stores.length > 1 && (
            <Select value={storeId} onValueChange={setStoreId}>
              <SelectTrigger className="w-52"><SelectValue placeholder="Tienda" /></SelectTrigger>
              <SelectContent>{stores.map((s) => <SelectItem key={s.id} value={s.id}>{s.code} · {s.name}</SelectItem>)}</SelectContent>
            </Select>
          )}
          <Input type="date" value={weekStart} onChange={(e) => e.target.value && setWeekStart(mondayISOf(e.target.value))} className="w-40" />
          <span className="text-xs text-muted-foreground tabular-nums">{fmtDM(weekStart)} – {fmtDM(weekEnd)}</span>
        </div>
      </div>

      {loading || !coverage || !store ? (
        <div className="text-center py-10 text-muted-foreground">Cargando…</div>
      ) : (
        <>
          {/* Cobertura */}
          <div className="bg-card rounded-2xl border border-border overflow-hidden">
            <div className="p-4 border-b border-border">
              <h3 className="font-semibold text-foreground">Cobertura por turno y día</h3>
              <p className="text-xs text-muted-foreground">Cuántas personas quieres por turno cada día (L–D). El motor lo respeta exacto. Se basa en <b>agentes reales</b>: {store.prodHC} Prod · {store.mbkHC} MBK{(store.mbkBudget != null && store.mbkBudget !== store.mbkHC) || (store.prodBudget != null && store.prodBudget !== store.prodHC) ? ` (dotación autorizada: ${store.prodBudget ?? "—"} Prod · ${store.mbkBudget ?? "—"} MBK)` : ""}.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[560px]">
                <thead><tr className="bg-secondary/50">
                  <th className="text-left p-2 font-medium">Turno</th>
                  {SCH_DAYS.map((d, i) => <th key={i} className="p-2 text-center font-medium">{d.slice(0, 3)}</th>)}
                </tr></thead>
                <tbody>
                  {SCH_SHIFT_KEYS.map((k) => (
                    <tr key={k} className="border-t border-border">
                      <td className="p-2 font-medium whitespace-nowrap">{SCH_SHIFT_DEF[k].short}</td>
                      {coverage[k].map((v, d) => (
                        <td key={d} className="p-1 text-center">
                          <input type="number" min={0} max={6} value={v} onChange={(e) => updateCov(k, d, Number(e.target.value))} className="w-12 h-8 text-center rounded-md border border-border bg-background" />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="p-3 flex flex-wrap gap-4 border-t border-border">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!coverage.sundayMbkSingle} onChange={(e) => setCoverage((c) => (c ? { ...c, sundayMbkSingle: e.target.checked } : c))} /> Domingo MBK 1 turno</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!coverage.mbkLean} onChange={(e) => setCoverage((c) => (c ? { ...c, mbkLean: e.target.checked } : c))} /> Esquema eficiente MBK (Mié/Jue/Dom con 1)</label>
            </div>
          </div>

          {/* Equipo */}
          <div className="bg-card rounded-2xl border border-border overflow-hidden">
            <div className="p-4 border-b border-border">
              <h3 className="font-semibold text-foreground">Equipo <span className="text-xs font-normal text-muted-foreground">({team.length} agendables)</span></h3>
              <p className="text-xs text-muted-foreground">Los cajeros (Productos) y agentes MBK de la tienda. Sus atributos se guardan al editar. <b>Apoya MBK</b> = agente de Productos calificado para cubrir Bankito.</p>
              {!hasPrior && <p className="text-xs mt-1 text-amber-700">Primer horario de esta tienda: marca quién <b>cerró el domingo noche pasado</b> para respetar su descanso el lunes.</p>}
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader><TableRow className="bg-secondary/50">
                  <TableHead>Colaborador</TableHead><TableHead>Área</TableHead><TableHead>Puesto</TableHead>
                  <TableHead className="text-center">Apoya MBK</TableHead>
                  {!hasPrior && <TableHead className="text-center">Cerró dom.</TableHead>}
                  <TableHead>Estudia</TableHead><TableHead>No disponible</TableHead><TableHead className="text-right">Horas</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {team.length === 0 ? (
                    <TableRow><TableCell colSpan={hasPrior ? 7 : 8} className="text-center py-6 text-muted-foreground">Sin cajeros ni agentes MBK activos.</TableCell></TableRow>
                  ) : team.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">{p.nombre}</TableCell>
                      <TableCell className="text-muted-foreground">{p.area === "MBK" ? "MBK" : "Productos"}</TableCell>
                      <TableCell>
                        <select value={p.puesto} onChange={(e) => updateTeamAttr(p.id, { puesto: e.target.value as SchedPerson["puesto"] }, { puesto_horario: e.target.value })} className="h-8 rounded-md border border-border bg-background text-sm px-1">
                          {["AGENTE", "APOYO", "NUEVO", "PASANTE", "SASA"].map((x) => <option key={x} value={x}>{x}</option>)}
                        </select>
                      </TableCell>
                      <TableCell className="text-center">
                        {p.area === "MBK"
                          ? <span className="text-xs text-emerald-700">✓ MBK</span>
                          : <input type="checkbox" checked={!!p.mbkQ} onChange={(e) => updateTeamAttr(p.id, { mbkQ: e.target.checked }, { apoya_mbk: e.target.checked })} title="Calificado para cubrir Bankito" />}
                      </TableCell>
                      {!hasPrior && (
                        <TableCell className="text-center">
                          {p.area === "PRODUCTOS"
                            ? <input type="checkbox" checked={domPrevIds.includes(p.id)} onChange={() => toggleDomPrev(p.id)} title="Cerró el turno de domingo noche la semana pasada" />
                            : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                      )}
                      <TableCell>
                        <select value={p.estudia} onChange={(e) => updateTeamAttr(p.id, { estudia: e.target.value as SchedPerson["estudia"] }, { estudia: e.target.value })} className="h-8 rounded-md border border-border bg-background text-sm px-1">
                          <option value="">No</option><option value="Sábado">Sábado</option><option value="Domingo">Domingo</option>
                        </select>
                      </TableCell>
                      <TableCell>
                        <Input defaultValue={p.noDisponible} onBlur={(e) => { if (e.target.value !== p.noDisponible) updateTeamAttr(p.id, { noDisponible: e.target.value }, { no_disponible: e.target.value }); }} placeholder="Ej. Viernes" className="h-8 w-28" />
                      </TableCell>
                      <TableCell className="text-right">
                        <Input type="number" min={8} max={60} defaultValue={p.horasMeta} onBlur={(e) => { const v = Number(e.target.value) || 48; if (v !== p.horasMeta) updateTeamAttr(p.id, { horasMeta: v }, { horas_meta: v }); }} className="h-8 w-16 text-right" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>

          {/* Generar */}
          <div className="flex items-center gap-3 flex-wrap">
            <Button className="bg-accent text-accent-foreground hover:bg-accent/90" disabled={busy !== "" || !team.length} onClick={doGenerate}>
              {busy === "gen" ? <><Loader2Spin /> Generando…</> : <><CalendarPlus className="h-4 w-4 mr-1" /> Generar horario</>}
            </Button>
            {savedStatus && <Badge variant="outline" className={savedStatus === "approved" ? "border-emerald-500 text-emerald-700" : "border-amber-500 text-amber-700"}>{savedStatus === "approved" ? "Aprobado" : "Borrador guardado"}</Badge>}
            {covPct != null && <span className="text-sm text-muted-foreground">Cobertura cubierta: <b className={covPct >= 100 ? "text-emerald-700" : "text-amber-700"}>{covPct}%</b></span>}
          </div>

          {/* Rejilla + alertas + resumen */}
          {schedule && (
            <>
              <div className="bg-card rounded-2xl border border-border overflow-hidden">
                <div className="p-4 border-b border-border flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <h3 className="font-semibold text-foreground">Horario propuesto</h3>
                    <p className="text-xs text-muted-foreground">Editable a mano: <b>×</b> quita un turno · <b>+ agregar</b> asigna a cualquier agente (te avisa si rompe una regla) · <b>toca un nombre</b> para ver toda su semana.</p>
                  </div>
                  <Button variant="outline" size="sm" onClick={printSchedule}><Printer className="h-4 w-4 mr-1" /> Imprimir</Button>
                </div>
                {selEmp && (
                  <div className="px-4 py-2 bg-secondary/40 border-b border-border flex items-center justify-between gap-2 flex-wrap text-sm">
                    <span>Resaltando a <b>{nameOf(selEmp)}</b>{(() => { const s = summary.find((x) => x.id === selEmp); return s ? ` · ${s.turns} turno(s) · ${s.hours}h de ${s.horasMeta}h` : ""; })()}</span>
                    <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setSelEmp(null)}>quitar resaltado</button>
                  </div>
                )}
                <div className="overflow-x-auto">
                  <table className="w-full text-sm table-fixed min-w-[600px]">
                    <thead><tr className="bg-secondary/50">
                      <th className="text-left p-1.5 font-medium w-[72px]">Turno</th>
                      {SCH_DAYS.map((d, i) => <th key={i} className="p-1.5 text-left font-medium">{d.slice(0, 3)}<br /><span className="text-[10px] font-normal text-muted-foreground">{fmtDM(addDaysISO(weekStart, i))}</span></th>)}
                    </tr></thead>
                    <tbody>
                      {SCH_SHIFT_KEYS.map((k) => {
                        const st = SCHEDULE_ROW_STYLES[k] ?? { label: "", chip: "bg-secondary border-border" };
                        return (
                          <tr key={k} className="border-t border-border align-top">
                            <td className={`p-1.5 text-xs font-semibold leading-tight ${st.label}`}>{SCH_SHIFT_DEF[k].short}</td>
                            {schedule[k].map((arr, d) => {
                              const need = coverage[k][d];
                              const caja = arr.filter((a) => (a as SchedAssign).role !== "APOYO").length;
                              return (
                                <td key={d} className="p-1 align-top">
                                  <div className="flex flex-col gap-1">
                                    {arr.map((it, i) => {
                                      const a = it as SchedAssign;
                                      const sel = selEmp === it.id;
                                      const marcas = [a.role === "APOYO" ? "apoyo" : "", a.supportFrom ? "cruzado" : "", a.override ? "⚠ autorizado" : ""].filter(Boolean).join(" · ");
                                      return (
                                        <span key={i} className={`text-[11px] rounded-md border px-1.5 py-1 flex items-start gap-1 ${st.chip} ${a.role === "APOYO" ? "opacity-70 border-dashed" : ""} ${a.supportFrom ? "border-orange-400 border-dashed" : ""} ${a.override ? "ring-1 ring-amber-500" : ""} ${sel ? "ring-2 ring-foreground/70 font-semibold" : ""}`}>
                                          <button type="button" onClick={() => setSelEmp(sel ? null : it.id)} className="flex-1 min-w-0 text-left leading-tight break-words" title={`${nameOf(it.id)}${marcas ? ` (${marcas})` : ""} — ver toda su semana`}>
                                            {shortName(nameOf(it.id))}
                                            {marcas ? <span className="block text-[9px] opacity-75">{marcas}</span> : null}
                                          </button>
                                          <button type="button" onClick={() => removeFromCell(k, d, i)} className="leading-none shrink-0 text-muted-foreground hover:text-red-600" title="Quitar turno">×</button>
                                        </span>
                                      );
                                    })}
                                    {/* Todos los agentes: el GT decide a quién darle el turno (no se sugiere). */}
                                    <select value="" onChange={(e) => { addToCell(k, d, e.target.value); e.currentTarget.value = ""; }} className="w-full min-w-0 text-[10px] h-6 rounded border border-dashed border-border bg-background/60 text-muted-foreground">
                                      <option value="">+ agregar…</option>
                                      {team.filter((p) => !arr.some((a) => a.id === p.id)).map((p) => (
                                        <option key={p.id} value={p.id}>{p.nombre} · {p.area === "MBK" ? "MBK" : "Prod"}</option>
                                      ))}
                                    </select>
                                  </div>
                                  {caja < need && <span className="mt-1 inline-block text-[10px] font-semibold text-red-700 bg-red-50 border border-red-200 rounded px-1">falta {need - caja}</span>}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {alerts.length > 0 && (
                <div className="bg-card rounded-2xl border border-border p-4 space-y-2">
                  <button type="button" onClick={() => setShowRules((v) => !v)} className="w-full flex items-center justify-between gap-2 text-left">
                    <span className={`text-sm font-semibold ${bad.length ? "text-red-700" : "text-amber-700"}`}>
                      {bad.length > 0 ? `${bad.length} regla(s) crítica(s)` : "Sin reglas críticas"} · {warn.length} advertencia(s)
                    </span>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">{showRules ? "ocultar ▲" : "ver detalle ▼"}</span>
                  </button>
                  {showRules && (
                    <div className="space-y-1 max-h-64 overflow-y-auto">
                      {alerts.map((a, i) => (
                        <div key={i} className={`text-xs rounded-md px-2 py-1 border ${a.level === "bad" ? "bg-red-50 border-red-200 text-red-800" : "bg-amber-50 border-amber-200 text-amber-800"}`}>{a.text}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="bg-card rounded-2xl border border-border overflow-hidden">
                <div className="p-4 border-b border-border"><h3 className="font-semibold text-foreground">Resumen por colaborador</h3></div>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader><TableRow className="bg-secondary/50"><TableHead>Colaborador</TableHead><TableHead>Área</TableHead><TableHead className="text-center">Turnos</TableHead><TableHead className="text-right">Horas</TableHead><TableHead>Meta</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {summary.map((p) => (
                        <TableRow key={p.id}>
                          <TableCell className="font-medium">{p.nombre}</TableCell>
                          <TableCell className="text-muted-foreground">{p.area === "MBK" ? "MBK" : "Productos"}</TableCell>
                          <TableCell className="text-center">{p.turns}</TableCell>
                          <TableCell className="text-right font-medium">{p.hours}</TableCell>
                          <TableCell><span className={p.hours >= p.horasMeta ? "text-emerald-700" : "text-amber-700"}>{p.hours}/{p.horasMeta}h</span></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>

              <div className="flex items-center gap-3 flex-wrap">
                <Button variant="outline" disabled={busy !== ""} onClick={() => doSave("draft")}>{busy === "save" ? "Guardando…" : "Guardar borrador"}</Button>
                <Button className="bg-emerald-600 text-white hover:bg-emerald-700" disabled={busy !== "" || bad.length > 0} onClick={() => doSave("approved")}>{busy === "approve" ? "Aprobando…" : "Aprobar y guardar"}</Button>
                {bad.length > 0 && <span className="text-xs text-red-700">Resuelve las reglas rojas antes de aprobar.</span>}
              </div>
            </>
          )}

          {/* Adherencia (Fase 2): plan guardado vs marcaje real */}
          <div className="bg-card rounded-2xl border border-border p-4 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="min-w-0">
                <h3 className="font-semibold text-foreground">Adherencia · plan vs marcaje</h3>
                <p className="text-xs text-muted-foreground">Compara el horario guardado de esta semana con quién marcó realmente en la tienda.</p>
              </div>
              <Button variant="outline" size="sm" disabled={adhBusy} onClick={loadAdherence}>{adhBusy ? "Cargando…" : "Ver adherencia"}</Button>
            </div>
            {adh && (!adh.found ? (
              <p className="text-sm text-muted-foreground">No hay horario guardado para esta semana. Genera y guarda/aprueba uno primero.</p>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  <div className="rounded-xl border border-border p-3 text-center">
                    <div className={`text-2xl font-bold ${adh.totals.adherencePct >= 90 ? "text-emerald-700" : adh.totals.adherencePct >= 70 ? "text-amber-700" : "text-red-700"}`}>{adh.totals.adherencePct}%</div>
                    <div className="text-xs text-muted-foreground">Adherencia ({adh.totals.present}/{adh.totals.planned})</div>
                  </div>
                  <div className="rounded-xl border border-border p-3 text-center">
                    <div className={`text-2xl font-bold ${adh.totals.punctualityPct >= 90 ? "text-emerald-700" : "text-amber-700"}`}>{adh.totals.punctualityPct}%</div>
                    <div className="text-xs text-muted-foreground">Puntualidad</div>
                  </div>
                  <div className="rounded-xl border border-border p-3 text-center">
                    <div className={`text-2xl font-bold ${adh.totals.absent ? "text-red-700" : "text-emerald-700"}`}>{adh.totals.absent}</div>
                    <div className="text-xs text-muted-foreground">Ausencias</div>
                  </div>
                  <div className="rounded-xl border border-border p-3 text-center">
                    <div className="text-2xl font-bold text-foreground">{adh.totals.extra}</div>
                    <div className="text-xs text-muted-foreground">Extras · {adh.totals.late} tarde</div>
                  </div>
                </div>
                {(adh.noShows.length > 0 || adh.lates.length > 0 || adh.extras.length > 0) && (
                  <div className="grid md:grid-cols-3 gap-3 text-xs">
                    <div>
                      <div className="font-semibold text-red-700 mb-1">Ausencias ({adh.noShows.length})</div>
                      <div className="space-y-0.5">{adh.noShows.length ? adh.noShows.map((n, i) => <div key={i} className="text-muted-foreground">{n.name} · {n.day} {n.shift}</div>) : <div className="text-muted-foreground">—</div>}</div>
                    </div>
                    <div>
                      <div className="font-semibold text-amber-700 mb-1">Tardanzas ({adh.lates.length})</div>
                      <div className="space-y-0.5">{adh.lates.length ? adh.lates.map((l, i) => <div key={i} className="text-muted-foreground">{l.name} · {l.day} {l.shift} · {l.enteredAt} (esp. {l.expected})</div>) : <div className="text-muted-foreground">—</div>}</div>
                    </div>
                    <div>
                      <div className="font-semibold text-foreground mb-1">Extras ({adh.extras.length})</div>
                      <div className="space-y-0.5">{adh.extras.length ? adh.extras.map((x, i) => <div key={i} className="text-muted-foreground">{x.name} · {x.day} · {x.enteredAt}</div>) : <div className="text-muted-foreground">—</div>}</div>
                    </div>
                  </div>
                )}
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted-foreground">Desglose por colaborador</summary>
                  <div className="overflow-x-auto mt-2">
                    <Table>
                      <TableHeader><TableRow className="bg-secondary/50"><TableHead>Colaborador</TableHead><TableHead className="text-center">Plan</TableHead><TableHead className="text-center">Presente</TableHead><TableHead className="text-center">Ausente</TableHead><TableHead className="text-center">Tarde</TableHead><TableHead className="text-center">Extra</TableHead></TableRow></TableHeader>
                      <TableBody>
                        {adh.byEmployee.map((e) => (
                          <TableRow key={e.id}>
                            <TableCell className="font-medium">{e.name}</TableCell>
                            <TableCell className="text-center">{e.planned}</TableCell>
                            <TableCell className="text-center text-emerald-700">{e.present}</TableCell>
                            <TableCell className={`text-center ${e.absent ? "text-red-700 font-semibold" : ""}`}>{e.absent}</TableCell>
                            <TableCell className={`text-center ${e.late ? "text-amber-700" : ""}`}>{e.late}</TableCell>
                            <TableCell className="text-center">{e.extra}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </details>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Loader2Spin() { return <Loader2 className="h-4 w-4 mr-1 animate-spin inline" />; }

function KPI({ label, value, accent, sub }: { label: string; value: number | string; accent: "entry" | "exit" | "primary" | "muted"; sub?: string }) {
  const cls = {
    entry: "bg-[oklch(0.65_0.16_155)] text-white",
    exit: "bg-accent text-accent-foreground",
    primary: "bg-primary text-primary-foreground",
    muted: "bg-secondary text-foreground",
  }[accent];
  return (
    <div className={`rounded-2xl p-4 ${cls}`}>
      <div className="text-3xl font-bold leading-none">{value}</div>
      <div className="text-xs mt-2 opacity-90">{label}</div>
      {sub && <div className="text-[11px] mt-0.5 opacity-80">{sub}</div>}
    </div>
  );
}

/**
 * Marcaje de gerentes del día. Para el Gerente de Zona: si sus Gerentes de Tienda
 * marcaron y a qué hora. Para la Administración: además el recorrido de cada
 * Gerente de Zona (en qué tienda inició y en cuál cerró).
 */
function ManagerMarksCards({ storeId, zoneId }: { storeId: string; zoneId: string }) {
  const fn = useServerFn(getManagerMarks);
  const args: { storeId?: string; zoneId?: string } = {};
  if (storeId !== "all") args.storeId = storeId;
  else if (zoneId !== "all") args.zoneId = zoneId;
  const { data } = useQuery({
    queryKey: ["managerMarks", zoneId, storeId],
    queryFn: () => fn({ data: args }),
    refetchInterval: 60_000,
  });
  if (!data) return null;
  const gts = data.gerentes ?? [];
  const gzs = data.zonales ?? [];
  const sinMarcar = gts.filter((g) => !g.entrada).length;
  const tarde = gts.filter((g) => g.tarde).length;

  return (
    <div className="space-y-4">
      <div className="bg-card rounded-2xl border border-border overflow-hidden">
        <div className="p-4 border-b border-border flex items-center gap-2 flex-wrap">
          <h3 className="font-semibold text-foreground">Marcaje · Gerentes de Tienda</h3>
          <Badge variant="outline">{gts.length}</Badge>
          {sinMarcar > 0 && (
            <Badge className="bg-destructive text-destructive-foreground hover:bg-destructive">
              {sinMarcar} sin marcar
            </Badge>
          )}
          {tarde > 0 && (
            <Badge variant="outline" className="border-amber-500 text-amber-700">{tarde} tarde</Badge>
          )}
          <p className="w-full text-xs text-muted-foreground">
            Entrada contra las 8:00 (tolerancia 5 min) · ordenado del más atrasado
          </p>
        </div>
        {gts.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">Sin Gerentes de Tienda en este alcance.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-secondary/50">
                  <TableHead>Gerente</TableHead>
                  <TableHead>Tienda</TableHead>
                  <TableHead>Entrada</TableHead>
                  <TableHead>Salida</TableHead>
                  <TableHead className="text-right">Estado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {gts.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell>
                      <div className="font-medium text-foreground">{g.name}</div>
                      <div className="text-xs text-muted-foreground font-mono">{g.code}</div>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">{g.tienda}</TableCell>
                    <TableCell className="font-mono text-sm">
                      {g.entrada ?? <span className="text-destructive font-sans">—</span>}
                      {g.entrada && g.entradaTienda && g.entradaTienda !== g.tiendaCode && (
                        <div className="text-[11px] text-amber-700 font-sans">en {g.entradaTienda}</div>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {g.salida ?? (
                        g.dentro
                          ? <span className="text-xs text-muted-foreground font-sans">en tienda</span>
                          : <span className="text-muted-foreground font-sans">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {!g.entrada ? (
                        <Badge className="bg-destructive text-destructive-foreground hover:bg-destructive">Sin marcar</Badge>
                      ) : !g.evaluable ? (
                        <Badge variant="secondary">fuera del turno 8:00</Badge>
                      ) : g.tarde ? (
                        <Badge variant="outline" className="border-amber-500 text-amber-700">
                          {g.atraso} min tarde
                        </Badge>
                      ) : (
                        <Badge className="bg-[oklch(0.65_0.16_155)] text-white hover:bg-[oklch(0.65_0.16_155)]">A tiempo</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {data.verZonales && (
        <div className="bg-card rounded-2xl border border-border overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-foreground">Marcaje · Gerentes de Zona</h3>
            <Badge variant="outline">{gzs.length}</Badge>
            <p className="w-full text-xs text-muted-foreground">
              Recorrido de hoy. Managua: 8:00 de martes a viernes en su primera tienda ·
              Foráneas: 8:00 los lunes en su tienda base. Los demás días el recorrido varía y no se califica.
            </p>
          </div>
          {gzs.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">Sin Gerentes de Zona en este alcance.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-secondary/50">
                    <TableHead>Gerente de Zona</TableHead>
                    <TableHead>Zona</TableHead>
                    <TableHead>Inició</TableHead>
                    <TableHead>Cerró</TableHead>
                    <TableHead className="text-right">Tiendas</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {gzs.map((z) => (
                    <TableRow key={z.id}>
                      <TableCell>
                        <div className="font-medium text-foreground">{z.name}</div>
                        <div className="text-xs text-muted-foreground font-mono">{z.code}</div>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {z.zona}
                        <div className="text-[11px] opacity-75">{z.regla}</div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {z.inicioHora ? (
                          <>
                            <div>
                              <span className="font-mono">{z.inicioHora}</span> ·{" "}
                              <span className="font-mono text-muted-foreground">{z.inicioTienda}</span>
                            </div>
                            {z.evaluable && z.tarde && (
                              <div className="text-[11px] text-amber-700">{z.atraso} min tarde</div>
                            )}
                            {z.fueraDeBase && (
                              <div className="text-[11px] text-amber-700">no arrancó en su base ({z.baseTienda})</div>
                            )}
                          </>
                        ) : z.exigible ? (
                          <Badge className="bg-destructive text-destructive-foreground hover:bg-destructive">Sin marcar</Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                        {!z.exigible && (
                          <div className="text-[11px] text-muted-foreground">recorrido variable hoy</div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {z.cierreHora ? (
                          <><span className="font-mono">{z.cierreHora}</span> · <span className="font-mono text-muted-foreground">{z.cierreTienda}</span></>
                        ) : z.dentro ? (
                          <span className="text-xs text-muted-foreground">en recorrido</span>
                        ) : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="font-semibold text-foreground">{z.paradas}</div>
                        {z.recorrido.length > 1 && (
                          <div className="text-[11px] text-muted-foreground font-mono">{z.recorrido.join(" → ")}</div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function InsideCard({ inside }: { inside: Array<{ id: string; full_name: string; employee_code: string; since: string }> }) {
  return (
    <div className="bg-card rounded-2xl border border-border overflow-hidden">
      <div className="p-4 border-b border-border">
        <h3 className="font-semibold text-foreground">Dentro ahora</h3>
        <p className="text-xs text-muted-foreground">Entrada sin salida registrada hoy</p>
      </div>
      <Table>
        <TableHeader><TableRow className="bg-secondary/50"><TableHead>Colaborador</TableHead><TableHead className="text-right">Desde</TableHead></TableRow></TableHeader>
        <TableBody>
          {inside.length === 0 ? (
            <TableRow><TableCell colSpan={2} className="text-center py-6 text-muted-foreground">Nadie adentro.</TableCell></TableRow>
          ) : inside.map((i) => (
            <TableRow key={i.id}>
              <TableCell><div className="font-medium text-foreground">{i.full_name}</div><div className="text-xs text-muted-foreground font-mono">{i.employee_code}</div></TableCell>
              <TableCell className="text-right text-sm text-muted-foreground">{new Date(i.since).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function TurnoTypeCard({ personas }: { personas?: { total: number; by_type: Array<{ tipo: string; count: number }> } }) {
  const rows = personas?.by_type ?? [];
  return (
    <div className="bg-card rounded-2xl border border-border overflow-hidden">
      <div className="p-4 border-b border-border">
        <h3 className="font-semibold text-foreground">Personas en el turno actual</h3>
        <p className="text-xs text-muted-foreground">Total logeado por tipo (informativo, sin plan)</p>
      </div>
      <Table>
        <TableHeader><TableRow className="bg-secondary/50"><TableHead>Tipo</TableHead><TableHead className="text-right">Logeados</TableHead></TableRow></TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.tipo}>
              <TableCell className="text-foreground">{r.tipo}</TableCell>
              <TableCell className="text-right">{r.count > 0 ? <span className="font-medium">{r.count}</span> : <span className="text-muted-foreground">—</span>}</TableCell>
            </TableRow>
          ))}
          <TableRow className="bg-secondary/30">
            <TableCell className="font-semibold text-foreground">Total en tienda</TableCell>
            <TableCell className="text-right font-semibold">{personas?.total ?? 0}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

function LateTodayCard({ rows }: { rows?: Array<{ id: string; name: string; code: string; area: string; turno: string; hora: string; atraso: number }> }) {
  const list = rows ?? [];
  return (
    <div className="bg-card rounded-2xl border border-border overflow-hidden">
      <div className="p-4 border-b border-border flex items-center gap-2">
        <h3 className="font-semibold text-foreground">Marcaron tarde hoy</h3>
        <Badge variant="outline" className="border-red-500 text-red-700">{list.length}</Badge>
      </div>
      {list.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">Nadie marcó tarde hoy. 🎉</p>
      ) : (
        <Table>
          <TableHeader><TableRow className="bg-secondary/50"><TableHead>Colaborador</TableHead><TableHead>Turno</TableHead><TableHead className="text-right">Entró</TableHead><TableHead className="text-right">Atraso</TableHead></TableRow></TableHeader>
          <TableBody>
            {list.slice(0, 25).map((r) => (
              <TableRow key={`${r.id}-${r.turno}`}>
                <TableCell><div className="font-medium text-foreground">{r.name}</div><div className="text-xs text-muted-foreground font-mono">{r.code}</div></TableCell>
                <TableCell className="text-sm text-muted-foreground">{r.area} {r.turno}</TableCell>
                <TableCell className="text-right font-mono text-sm">{r.hora}</TableCell>
                <TableCell className="text-right"><span className="text-xs font-medium rounded-md border border-red-200 bg-red-50 text-red-800 px-2 py-1">+{r.atraso} min</span></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function OvertimeCard({ rows }: { rows?: Array<{ id: string; name: string; code: string; area: string; turno: string; cierre: string; salida: string | null; extra: number; dentro: boolean }> }) {
  const list = rows ?? [];
  const fmtExtra = (mm: number) => (mm >= 60 ? `+${Math.floor(mm / 60)}:${String(mm % 60).padStart(2, "0")}` : `+${mm} min`);
  return (
    <div className="bg-card rounded-2xl border border-border overflow-hidden">
      <div className="p-4 border-b border-border flex items-center gap-2">
        <h3 className="font-semibold text-foreground">Salidas fuera de hora</h3>
        <Badge variant="outline" className="border-amber-500 text-amber-700">{list.length}</Badge>
      </div>
      {list.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">Sin salidas fuera de hora.</p>
      ) : (
        <Table>
          <TableHeader><TableRow className="bg-secondary/50"><TableHead>Colaborador</TableHead><TableHead>Cierre</TableHead><TableHead className="text-right">Salió</TableHead><TableHead className="text-right">Extra</TableHead></TableRow></TableHeader>
          <TableBody>
            {list.slice(0, 25).map((r) => (
              <TableRow key={`${r.id}-${r.turno}-${r.salida ?? "in"}`}>
                <TableCell><div className="font-medium text-foreground">{r.name}</div><div className="text-xs text-muted-foreground font-mono">{r.code}</div></TableCell>
                <TableCell className="text-sm text-muted-foreground">{r.cierre}</TableCell>
                <TableCell className="text-right text-sm">{r.dentro ? <span className="text-muted-foreground">dentro</span> : <span className="font-mono">{r.salida}</span>}</TableCell>
                <TableCell className="text-right"><span className={`text-xs font-medium rounded-md border px-2 py-1 ${r.dentro ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>{fmtExtra(r.extra)}</span></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function RoleTable({ rows }: { rows: Array<{ role: string; employees: number; present: number }> }) {
  return (
    <Table>
      <TableHeader><TableRow className="bg-secondary/50"><TableHead>Tipo</TableHead><TableHead className="text-right">Presentes</TableHead><TableHead className="text-right">Total</TableHead></TableRow></TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow><TableCell colSpan={3} className="text-center py-6 text-muted-foreground">Sin colaboradores.</TableCell></TableRow>
        ) : rows.map((r) => (
          <TableRow key={r.role}>
            <TableCell className="text-foreground">{ROLE_LABELS[r.role as EmployeeRole] ?? r.role}</TableCell>
            <TableCell className="text-right font-medium">{r.present}</TableCell>
            <TableCell className="text-right text-muted-foreground">{r.employees}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function StoreExecTable({ title, subtitle, rows }: {
  title: string; subtitle: string;
  rows: Array<{ id: string; code: string; name: string; employees: number; present_today: number; inside_now: number; today_entries: number; period_total: number }>;
}) {
  return (
    <div className="bg-card rounded-2xl border border-border overflow-hidden">
      <div className="p-4 border-b border-border">
        <h3 className="font-semibold text-foreground">{title}</h3>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow className="bg-secondary/50">
            <TableHead>Tienda</TableHead>
            <TableHead className="text-right">Presentes</TableHead>
            <TableHead className="text-right">Dentro</TableHead>
            <TableHead className="text-right">Entradas hoy</TableHead>
            <TableHead className="text-right">Total</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow><TableCell colSpan={5} className="text-center py-6 text-muted-foreground">Sin tiendas.</TableCell></TableRow>
            ) : rows.map((s) => (
              <TableRow key={s.id}>
                <TableCell><span className="font-mono text-foreground">{s.code}</span> <span className="text-muted-foreground">· {s.name}</span></TableCell>
                <TableCell className="text-right text-sm">{s.present_today}/{s.employees}</TableCell>
                <TableCell className="text-right text-sm">{s.inside_now}</TableCell>
                <TableCell className="text-right text-sm">{s.today_entries}</TableCell>
                <TableCell className="text-right text-sm font-medium">{s.period_total}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function DotCoverCell({ real, plan }: { real: number; plan: number }) {
  const ok = plan === 0 ? true : real >= plan;
  return (
    <span className={`text-sm font-medium ${plan === 0 ? "text-muted-foreground" : ok ? "text-[oklch(0.55_0.14_155)]" : "text-amber-700"}`}>
      {real}/{plan}
    </span>
  );
}

function StaffingBudgetCard({ zoneId, storeId }: { zoneId: string; storeId: string }) {
  const fn = useServerFn(getStaffingBudgetReport);
  const args: { storeId?: string; zoneId?: string } = {};
  if (storeId !== "all") args.storeId = storeId;
  else if (zoneId !== "all") args.zoneId = zoneId;
  const { data, isLoading } = useQuery({ queryKey: ["staffing-budget", zoneId, storeId], queryFn: () => fn({ data: args }) });
  const rows = data?.rows ?? [];
  const numCell = (real: number, bud: number, falta: number, exc: number) =>
    bud === 0
      ? <span className="text-muted-foreground">{real} <span className="text-[11px]">(sin pres.)</span></span>
      : <><b className={falta > 0 ? "text-red-700" : "text-emerald-700"}>{real}/{bud}</b>{exc > 0 && <span className="text-amber-700 text-xs"> (+{exc})</span>}</>;
  // Estado por DOTACIÓN TOTAL (Productos + MBK): un excedente en un área compensa un
  // faltante en la otra. Neto > 0 = Exceso; = 0 = Completa (con nota si hay que
  // redistribuir); < 0 = Faltan (lo que reclutamiento debe cubrir).
  const estadoNode = (r: { prodReal: number; prodBud: number; mbkReal: number; mbkBud: number; noBudget: boolean }) => {
    if (r.noBudget) return <span className="text-muted-foreground">Sin presupuesto</span>;
    const n = (r.prodReal + r.mbkReal) - (r.prodBud + r.mbkBud);
    if (n > 0) return <span className="text-amber-700 font-semibold">Exceso (+{n})</span>;
    if (n < 0) return <span className="text-red-700 font-semibold">Faltan {-n}</span>;
    if (r.prodReal === r.prodBud) return <span className="text-emerald-700 font-semibold">Completa</span>;
    const toMbk = r.mbkReal < r.mbkBud;
    return <span className="text-emerald-700 font-semibold">Completa <span className="text-amber-700 font-normal text-xs">· redistribuir {toMbk ? r.mbkBud - r.mbkReal : r.prodBud - r.prodReal} a {toMbk ? "MBK" : "Prod"}</span></span>;
  };
  const netFaltan = rows.reduce((a, r) => a + (r.noBudget ? 0 : Math.max(0, (r.prodBud + r.mbkBud) - (r.prodReal + r.mbkReal))), 0);
  const netExceso = rows.reduce((a, r) => a + (r.noBudget ? 0 : Math.max(0, (r.prodReal + r.mbkReal) - (r.prodBud + r.mbkBud))), 0);
  return (
    <div className="bg-card rounded-2xl border border-border overflow-hidden">
      <div className="p-4 border-b border-border">
        <h3 className="font-semibold text-foreground">Personal contratado vs presupuesto</h3>
        <p className="text-xs text-muted-foreground">Agentes activos cargados vs dotación autorizada. Los polivalentes cuentan en MBK. El "faltan" es lo que reclutamiento debe cubrir.</p>
      </div>
      {isLoading ? (
        <div className="p-6 text-center text-muted-foreground text-sm">Cargando…</div>
      ) : rows.length === 0 ? (
        <div className="p-6 text-center text-muted-foreground text-sm">Sin tiendas en tu alcance.</div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow className="bg-secondary/50">
                <TableHead>Tienda</TableHead>
                <TableHead className="text-center">Productos<br /><span className="text-[11px] font-normal text-muted-foreground">real / presup.</span></TableHead>
                <TableHead className="text-center">MBK<br /><span className="text-[11px] font-normal text-muted-foreground">real / presup.</span></TableHead>
                <TableHead>Estado</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.code}>
                    <TableCell className="font-medium"><b>{r.code}</b> <span className="text-muted-foreground font-normal">{r.name}</span></TableCell>
                    <TableCell className="text-center">{numCell(r.prodReal, r.prodBud, r.faltanProd, r.excProd)}</TableCell>
                    <TableCell className="text-center">{numCell(r.mbkReal, r.mbkBud, r.faltanMbk, r.excMbk)}</TableCell>
                    <TableCell>{estadoNode(r)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="p-3 border-t border-border text-sm">
            {netFaltan > 0
              ? <b className="text-red-700">Faltan {netFaltan} por reclutar</b>
              : <b className="text-emerald-700">Plantilla completa{rows.length === 1 ? "" : " en todas las tiendas"}</b>}
            {netExceso > 0 && <b className="text-amber-700"> · {netExceso} en exceso</b>}
            <span className="text-xs text-muted-foreground"> · el faltante ya descuenta excedentes de otra área; limpieza y seguridad aparte.</span>
          </div>
        </>
      )}
    </div>
  );
}

function DotacionStoreTable({ rows, prodCorte, mbkCorte }: {
  rows: Array<{ id: string; code: string; name: string;
    dot_prod_real: number; dot_prod_plan: number; dot_mbk_real: number; dot_mbk_plan: number;
    dot_wprod_real: number; dot_wprod_plan: number; dot_wmbk_real: number; dot_wmbk_plan: number }>;
  prodCorte: string; mbkCorte: string;
}) {
  const [view, setView] = useState<"day" | "week">("day");
  const day = view === "day";
  const corteLabel = prodCorte === mbkCorte ? `turno ${prodCorte}` : `Productos ${prodCorte} · MBK ${mbkCorte}`;
  return (
    <div className="bg-card rounded-2xl border border-border overflow-hidden">
      <div className="p-4 border-b border-border flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <h3 className="font-semibold text-foreground">Dotación real por tienda</h3>
          <p className="text-xs text-muted-foreground">
            {day ? `¿Lista para operar el ${corteLabel}? — Productos y MBK vs plan` : "Últimos 7 días — cobertura Productos y MBK vs plan"}
          </p>
        </div>
        <Tabs value={view} onValueChange={(v) => setView(v as "day" | "week")}>
          <TabsList className="bg-secondary border border-border">
            <TabsTrigger value="day" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">Turno actual</TabsTrigger>
            <TabsTrigger value="week" className="data-[state=active]:bg-accent data-[state=active]:text-accent-foreground">Semanal</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow className="bg-secondary/50">
            <TableHead>Tienda</TableHead>
            <TableHead className="text-right">Productos</TableHead>
            <TableHead className="text-right">MBK</TableHead>
            <TableHead className="text-right">Cumplimiento</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow><TableCell colSpan={4} className="text-center py-6 text-muted-foreground">Sin tiendas.</TableCell></TableRow>
            ) : rows.map((s) => {
              const pReal = day ? s.dot_prod_real : s.dot_wprod_real;
              const pPlan = day ? s.dot_prod_plan : s.dot_wprod_plan;
              const mReal = day ? s.dot_mbk_real : s.dot_wmbk_real;
              const mPlan = day ? s.dot_mbk_plan : s.dot_wmbk_plan;
              const ready = pReal >= pPlan && mReal >= mPlan;
              const pct = pPlan + mPlan > 0 ? Math.round(((pReal + mReal) / (pPlan + mPlan)) * 100) : 0;
              return (
                <TableRow key={s.id}>
                  <TableCell><span className="font-mono text-foreground">{s.code}</span> <span className="text-muted-foreground">· {s.name}</span></TableCell>
                  <TableCell className="text-right"><DotCoverCell real={pReal} plan={pPlan} /></TableCell>
                  <TableCell className="text-right"><DotCoverCell real={mReal} plan={mPlan} /></TableCell>
                  <TableCell className="text-right">
                    {day ? (
                      <span className="inline-flex items-center gap-2 justify-end">
                        <span className={`text-sm font-semibold ${pct >= 100 ? "text-[oklch(0.55_0.14_155)]" : "text-amber-700"}`}>{pct}%</span>
                        <span className={`text-xs font-medium rounded-md border px-2 py-1 ${ready ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
                          {ready ? "Listo" : "Falta"}
                        </span>
                      </span>
                    ) : (
                      <span className={`text-sm font-semibold ${pct >= 100 ? "text-[oklch(0.55_0.14_155)]" : "text-amber-700"}`}>{pct}%</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="px-4 py-2 text-[11px] text-muted-foreground border-t border-border">
        {day
          ? "Real/Plan del corte actual por área. Verde = cubierto, ámbar = falta. \"Listo\" solo si Productos y MBK están cubiertos."
          : "Suma de agentes presentes por día (Productos y MBK) vs la suma del plan, en los últimos 7 días."}
      </p>
    </div>
  );
}

function ZoneExecTable({ rows }: {
  rows: Array<{ zone_id: string; code: string; name: string; stores: number; employees: number; present_today: number; inside_now: number; today_entries: number; period_total: number }>;
}) {
  return (
    <div className="bg-card rounded-2xl border border-border overflow-hidden">
      <div className="p-4 border-b border-border">
        <h3 className="font-semibold text-foreground">Por zona</h3>
        <p className="text-xs text-muted-foreground">Resumen de cada zona</p>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow className="bg-secondary/50">
            <TableHead>Zona</TableHead>
            <TableHead className="text-right">Tiendas</TableHead>
            <TableHead className="text-right">Colab.</TableHead>
            <TableHead className="text-right">Presentes</TableHead>
            <TableHead className="text-right">Dentro</TableHead>
            <TableHead className="text-right">Entradas hoy</TableHead>
            <TableHead className="text-right">Total</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="text-center py-6 text-muted-foreground">Sin zonas.</TableCell></TableRow>
            ) : rows.map((z) => (
              <TableRow key={z.zone_id}>
                <TableCell><span className="font-mono text-foreground">{z.code}</span> <span className="text-muted-foreground">· {z.name}</span></TableCell>
                <TableCell className="text-right text-sm">{z.stores}</TableCell>
                <TableCell className="text-right text-sm">{z.employees}</TableCell>
                <TableCell className="text-right text-sm font-medium">{z.present_today}</TableCell>
                <TableCell className="text-right text-sm">{z.inside_now}</TableCell>
                <TableCell className="text-right text-sm">{z.today_entries}</TableCell>
                <TableCell className="text-right text-sm">{z.period_total}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// =====================================================================
// TIENDAS — panel limitado del Gerente de Zona (solo PIN terminal + contraseña GT)
// =====================================================================
function ZoneStoresPanel() {
  const storesFn = useServerFn(listStores);
  const setPinFn = useServerFn(setStoreTerminalPin);
  const resetPwFn = useServerFn(resetManagerPassword);
  const { data, isLoading } = useQuery({ queryKey: ["stores"], queryFn: () => storesFn() });
  const stores = data ?? [];
  const [pinStore, setPinStore] = useState<{ id: string; label: string } | null>(null);
  const [pinValue, setPinValue] = useState("");

  const savePin = async () => {
    if (!pinStore) return;
    if (!/^\d{4,8}$/.test(pinValue)) { toast.error("PIN de 4-8 dígitos"); return; }
    try {
      await setPinFn({ data: { storeId: pinStore.id, terminal_pin: pinValue } });
      toast.success("PIN de terminal actualizado");
      setPinStore(null);
      setPinValue("");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  };

  const resetPw = async (id: string, label: string) => {
    if (!confirm(`¿Restablecer la contraseña de acceso del Gerente de Tienda de ${label}?`)) return;
    try {
      const r = await resetPwFn({ data: { storeId: id } });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success("Contraseña restablecida");
      window.prompt(`Contraseña temporal para ${r.emails.join(", ")} (cópiala y entrégala al GT):`, r.password);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-foreground">Tiendas de mi zona</h2>
        <p className="text-sm text-muted-foreground">
          Puedes cambiar el <strong>PIN de terminal</strong> y restablecer la <strong>contraseña del Gerente de Tienda</strong>. El resto de la configuración la gestiona un Super administrador.
        </p>
      </div>
      <div className="bg-card rounded-2xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-secondary/50">
              <TableHead>Tienda</TableHead>
              <TableHead className="text-right">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={2} className="text-center py-8 text-muted-foreground">Cargando…</TableCell></TableRow>
            ) : stores.length === 0 ? (
              <TableRow><TableCell colSpan={2} className="text-center py-8 text-muted-foreground">No tienes tiendas asignadas.</TableCell></TableRow>
            ) : stores.map((s) => (
              <TableRow key={s.id}>
                <TableCell><span className="font-mono text-foreground">{s.code}</span> <span className="text-muted-foreground">· {s.name}</span></TableCell>
                <TableCell className="text-right space-x-1 whitespace-nowrap">
                  <Button variant="outline" size="sm" onClick={() => { setPinStore({ id: s.id, label: `${s.code} · ${s.name}` }); setPinValue(""); }}>
                    <KeyRound className="h-4 w-4 mr-1 text-amber-600" /> PIN terminal
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => resetPw(s.id, `${s.code} · ${s.name}`)}>
                    <ShieldCheck className="h-4 w-4 mr-1" /> Contraseña GT
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={!!pinStore} onOpenChange={(o) => { if (!o) { setPinStore(null); setPinValue(""); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>PIN de terminal — {pinStore?.label}</DialogTitle></DialogHeader>
          <div>
            <Label>Nuevo PIN de terminal (4-8 dígitos)</Label>
            <Input
              type="text"
              inputMode="numeric"
              maxLength={8}
              value={pinValue}
              onChange={(e) => setPinValue(e.target.value.replace(/\D/g, ""))}
              placeholder="Ej. 2580"
              autoFocus
            />
            <p className="text-xs text-muted-foreground mt-1">Con este código se vincula la tablet de la tienda al marcaje.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPinStore(null)}>Cancelar</Button>
            <Button onClick={savePin} className="bg-accent text-accent-foreground hover:bg-accent/90">Guardar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// =====================================================================
// TIENDAS
// =====================================================================
function StoresPanel() {
  const listFn = useServerFn(listStores);
  const createFn = useServerFn(createStore);
  const updateFn = useServerFn(updateStore);
  const deleteFn = useServerFn(deleteStore);
  const bulkFn = useServerFn(bulkCreateStores);
  const resetPwFn = useServerFn(resetManagerPassword);
  const zonesFn = useServerFn(listZones);
  const qc = useQueryClient();

  const resetPwStore = async (id: string, label: string) => {
    if (!confirm(`¿Restablecer la contraseña de acceso del Gerente de Tienda de ${label}?`)) return;
    try {
      const r = await resetPwFn({ data: { storeId: id } });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success("Contraseña restablecida");
      window.prompt(`Contraseña temporal para ${r.emails.join(", ")} (cópiala y entrégala al GT):`, r.password);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  };

  const { data, isLoading } = useQuery({ queryKey: ["stores"], queryFn: () => listFn() });
  const { data: zones } = useQuery({ queryKey: ["zones"], queryFn: () => zonesFn() });
  const stores = data ?? [];
  const zoneList = zones ?? [];

  const [open, setOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [editing, setEditing] = useState<(typeof stores)[number] | null>(null);
  const [form, setForm] = useState({ code: "", name: "", address: "", terminal_pin: "", active: true, zone_id: "" as string });
  const [geoForm, setGeoForm] = useState({ latitude: "", longitude: "", radius: "300" });

  useEffect(() => {
    if (editing) {
      const e = editing as { zone_id?: string | null };
      setForm({
        code: editing.code,
        name: editing.name,
        address: editing.address ?? "",
        terminal_pin: "",
        active: editing.active,
        zone_id: e.zone_id ?? "",
      });
      const g = editing as { latitude?: number | null; longitude?: number | null; geofence_radius_m?: number | null };
      setGeoForm({
        latitude: g.latitude != null ? String(g.latitude) : "",
        longitude: g.longitude != null ? String(g.longitude) : "",
        radius: g.geofence_radius_m != null ? String(g.geofence_radius_m) : "300",
      });
    } else {
      setForm({ code: "", name: "", address: "", terminal_pin: "", active: true, zone_id: "" });
      setGeoForm({ latitude: "", longitude: "", radius: "300" });
    }
  }, [editing, open]);

  const save = async () => {
    try {
      const lat = geoForm.latitude.trim() === "" ? null : Number(geoForm.latitude);
      const lng = geoForm.longitude.trim() === "" ? null : Number(geoForm.longitude);
      const radius = Number(geoForm.radius) || 300;
      if ((lat !== null && Number.isNaN(lat)) || (lng !== null && Number.isNaN(lng))) {
        toast.error("Latitud/longitud inválida");
        return;
      }
      if (editing) {
        await updateFn({
          data: {
            id: editing.id,
            name: form.name,
            address: form.address || null,
            active: form.active,
            latitude: lat,
            longitude: lng,
            geofence_radius_m: radius,
            zone_id: form.zone_id || null,
            ...(form.terminal_pin ? { terminal_pin: form.terminal_pin } : {}),
          },
        });
        toast.success("Tienda actualizada");
      } else {
        if (!form.terminal_pin) {
          toast.error("El PIN de terminal es obligatorio");
          return;
        }
        await createFn({
          data: {
            code: form.code,
            name: form.name,
            address: form.address || null,
            terminal_pin: form.terminal_pin,
            active: form.active,
            latitude: lat,
            longitude: lng,
            geofence_radius_m: radius,
            zone_id: form.zone_id || null,
          },
        });
        toast.success("Tienda creada");
      }
      setOpen(false);
      setEditing(null);
      qc.invalidateQueries({ queryKey: ["stores"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error al guardar");
    }
  };

  const remove = async (id: string) => {
    if (!confirm("¿Eliminar esta tienda? Si tiene colaboradores o marcajes, fallará.")) return;
    try {
      await deleteFn({ data: { id } });
      toast.success("Tienda eliminada");
      qc.invalidateQueries({ queryKey: ["stores"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error al eliminar");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-bold text-foreground">Tiendas y áreas</h2>
          <p className="text-sm text-muted-foreground">{stores.length} registradas</p>
        </div>
        <div className="flex gap-2">
          <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setEditing(null); }}>
            <DialogTrigger asChild>
              <Button className="bg-accent text-accent-foreground hover:bg-accent/90">
                <Plus className="h-4 w-4 mr-2" /> Nueva tienda
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editing ? "Editar tienda" : "Nueva tienda"}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Código</Label>
                    <Input
                      disabled={!!editing}
                      value={form.code}
                      onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                      placeholder="Ej. A01, CEDI, CP"
                    />
                  </div>
                  <div>
                    <Label>{editing ? "PIN nuevo (vacío = mantener)" : "PIN terminal"}</Label>
                    <Input
                      inputMode="numeric"
                      pattern="\d*"
                      maxLength={8}
                      value={form.terminal_pin}
                      onChange={(e) => setForm({ ...form, terminal_pin: e.target.value.replace(/\D/g, "") })}
                      placeholder="4-8 dígitos"
                    />
                  </div>
                </div>
                <div>
                  <Label>Nombre</Label>
                  <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ej. Sucursal A01 Centro" />
                </div>
                <div>
                  <Label>Dirección (opcional)</Label>
                  <Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
                </div>
                <div>
                  <Label>Zona</Label>
                  <Select value={form.zone_id || "__none__"} onValueChange={(v) => setForm({ ...form, zone_id: v === "__none__" ? "" : v })}>
                    <SelectTrigger><SelectValue placeholder="Sin zona" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Sin zona</SelectItem>
                      {zoneList.map((z) => (
                        <SelectItem key={z.id} value={z.id}>{z.code} · {z.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="border-t border-border pt-3">
                  <div className="flex items-center gap-2 mb-2">
                    <MapPin className="h-4 w-4 text-accent" />
                    <Label className="m-0">Geolocalización (opcional)</Label>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <Label className="text-xs">Latitud</Label>
                      <Input value={geoForm.latitude} onChange={(e) => setGeoForm({ ...geoForm, latitude: e.target.value })} placeholder="19.4326" />
                    </div>
                    <div>
                      <Label className="text-xs">Longitud</Label>
                      <Input value={geoForm.longitude} onChange={(e) => setGeoForm({ ...geoForm, longitude: e.target.value })} placeholder="-99.1332" />
                    </div>
                    <div>
                      <Label className="text-xs">Radio (m)</Label>
                      <Input value={geoForm.radius} onChange={(e) => setGeoForm({ ...geoForm, radius: e.target.value.replace(/\D/g, "") })} placeholder="300" />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">Saca lat/lng de Google Maps (clic derecho → copiar). Sin coords, no se valida ubicación.</p>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
                  Activa
                </label>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
                <Button onClick={save} className="bg-accent text-accent-foreground hover:bg-accent/90">Guardar</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="bg-card rounded-2xl border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-secondary/50">
              <TableHead>Código</TableHead>
              <TableHead>Nombre</TableHead>
              <TableHead>Zona</TableHead>
              <TableHead>Dirección</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead className="text-right">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Cargando…</TableCell></TableRow>
            ) : stores.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                Sin tiendas. Usa "Carga masiva" para crear A01–A95 de un solo paso.
              </TableCell></TableRow>
            ) : stores.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-mono text-foreground">{s.code}</TableCell>
                <TableCell className="font-medium text-foreground">{s.name}</TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {(() => {
                    const z = (s as { zones?: { code?: string; name?: string } | { code?: string; name?: string }[] }).zones;
                    const zone = Array.isArray(z) ? z[0] : z;
                    return zone?.code ? `${zone.code} · ${zone.name ?? ""}` : "—";
                  })()}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">{s.address ?? "—"}</TableCell>
                <TableCell>
                  {s.active ? (
                    <Badge className="bg-[oklch(0.65_0.16_155)] text-white hover:bg-[oklch(0.65_0.16_155)]">Activa</Badge>
                  ) : (
                    <Badge variant="secondary">Inactiva</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" title="Restablecer contraseña del Gerente de Tienda" onClick={() => resetPwStore(s.id, `${s.code} · ${s.name}`)}>
                    <ShieldCheck className="h-4 w-4 text-primary" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => { setEditing(s); setOpen(true); }}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => remove(s.id)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function BulkDialog({
  onDone,
  bulkFn,
}: {
  onDone: () => void;
  bulkFn: ReturnType<typeof useServerFn<typeof bulkCreateStores>>;
}) {
  const [mode, setMode] = useState<"stores" | "support">("stores");
  const [prefix, setPrefix] = useState("A");
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(95);
  const [pad, setPad] = useState(2);
  const [namePrefix, setNamePrefix] = useState("Sucursal");
  const [supportCsv, setSupportCsv] = useState("MONITOREO:Monitoreo\nCEDI:Centro de Distribución\nCP:Centro de Producción");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);

  const preview = (): { code: string; name: string }[] => {
    if (mode === "stores") {
      const items: { code: string; name: string }[] = [];
      for (let i = from; i <= to; i++) {
        const num = String(i).padStart(pad, "0");
        items.push({ code: `${prefix}${num}`, name: `${namePrefix} ${prefix}${num}` });
      }
      return items;
    }
    return supportCsv.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
      const [code, ...rest] = line.split(":");
      return { code: (code || "").trim().toUpperCase(), name: (rest.join(":").trim()) || (code || "").trim() };
    }).filter((x) => x.code);
  };

  const run = async () => {
    const items = preview();
    if (items.length === 0) { toast.error("Sin elementos a crear"); return; }
    if (!/^\d{4,8}$/.test(pin)) { toast.error("PIN inválido (4–8 dígitos)"); return; }
    setBusy(true);
    try {
      const r = await bulkFn({ data: { items, terminal_pin: pin } });
      toast.success(`Creadas: ${r.created} · Existentes: ${r.skipped}`);
      onDone();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error en carga masiva");
    } finally {
      setBusy(false);
    }
  };

  const items = preview();

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Carga masiva de tiendas/áreas</DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
        <div className="flex gap-2">
          <Button variant={mode === "stores" ? "default" : "outline"} size="sm" onClick={() => setMode("stores")}>
            Tiendas (rango)
          </Button>
          <Button variant={mode === "support" ? "default" : "outline"} size="sm" onClick={() => setMode("support")}>
            Áreas de apoyo
          </Button>
        </div>

        {mode === "stores" ? (
          <>
            <div className="grid grid-cols-4 gap-2">
              <div><Label>Prefijo</Label><Input value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} /></div>
              <div><Label>Desde</Label><Input type="number" value={from} onChange={(e) => setFrom(Number(e.target.value))} /></div>
              <div><Label>Hasta</Label><Input type="number" value={to} onChange={(e) => setTo(Number(e.target.value))} /></div>
              <div><Label>Dígitos</Label><Input type="number" value={pad} onChange={(e) => setPad(Number(e.target.value))} /></div>
            </div>
            <div>
              <Label>Prefijo de nombre</Label>
              <Input value={namePrefix} onChange={(e) => setNamePrefix(e.target.value)} placeholder="Ej. Sucursal" />
            </div>
          </>
        ) : (
          <div>
            <Label>Áreas (una por línea, formato CODIGO:Nombre)</Label>
            <textarea
              className="w-full mt-1 border border-border rounded-md p-2 text-sm bg-background min-h-[120px] font-mono"
              value={supportCsv}
              onChange={(e) => setSupportCsv(e.target.value)}
            />
          </div>
        )}

        <div>
          <Label>PIN de terminal (compartido para este lote)</Label>
          <Input
            inputMode="numeric"
            maxLength={8}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            placeholder="4-8 dígitos"
          />
        </div>

        <div className="text-xs text-muted-foreground">
          Se crearán <span className="font-semibold text-foreground">{items.length}</span> elementos.
          {items.length > 0 && (
            <span> Ej: <span className="font-mono">{items[0].code}</span> · {items[0].name}
              {items.length > 1 && <> … <span className="font-mono">{items[items.length - 1].code}</span></>}
            </span>
          )}
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={busy}>Cancelar</Button>
        <Button onClick={run} disabled={busy} className="bg-accent text-accent-foreground hover:bg-accent/90">
          {busy ? "Creando…" : `Crear ${items.length}`}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
function FingerprintButton({ employeeId, employeeName }: { employeeId: string; employeeName: string }) {
  const beginFn = useServerFn(beginWebauthnRegistration);
  const finishFn = useServerFn(finishWebauthnRegistration);
  const listFn = useServerFn(listEmployeeCredentials);
  const deleteFn = useServerFn(deleteEmployeeCredential);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [creds, setCreds] = useState<Array<{ id: string; device_label: string | null; created_at: string; last_used_at: string | null }>>([]);

  const refresh = async () => {
    try { setCreds(await listFn({ data: { employeeId } })); } catch { /* noop */ }
  };

  useEffect(() => { if (open) void refresh(); /* eslint-disable-next-line */ }, [open]);

  const register = async () => {
    setBusy(true);
    try {
      const opts = await beginFn({ data: { employeeId } });
      const att = await startRegistration({ optionsJSON: opts as Parameters<typeof startRegistration>[0]["optionsJSON"] });
      const label = navigator.userAgent.includes("Mobile") ? "Móvil" : "Escritorio";
      const res = await finishFn({ data: { employeeId, response: att, deviceLabel: label } });
      if (!res.ok) toast.error(res.error);
      else { toast.success("Huella registrada"); await refresh(); }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Cancelado o no soportado");
    } finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    if (!confirm("¿Eliminar esta huella?")) return;
    await deleteFn({ data: { id } });
    await refresh();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" title="Huellas registradas"><Fingerprint className="h-4 w-4" /></Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Huellas de {employeeName}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">Cada huella queda atada al dispositivo donde se registra. Pídele al colaborador que apoye el dedo cuando lo solicite el sistema.</p>
        <Button onClick={register} disabled={busy} className="bg-accent text-accent-foreground hover:bg-accent/90">
          <Fingerprint className="h-4 w-4 mr-2" /> {busy ? "Esperando…" : "Registrar huella en este dispositivo"}
        </Button>
        <div className="space-y-2">
          {creds.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-3">Sin huellas registradas.</p>
          ) : creds.map((c) => (
            <div key={c.id} className="flex items-center justify-between bg-secondary rounded-lg px-3 py-2">
              <div className="text-sm">
                <div className="font-medium">{c.device_label ?? "Dispositivo"}</div>
                <div className="text-xs text-muted-foreground">Registrada {new Date(c.created_at).toLocaleDateString("es-MX")}</div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => remove(c.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Enrolar el rostro de referencia de un colaborador (foto que el marcaje usa para
 * verificar identidad). Es un paso de UNA SOLA VEZ, separado del marcaje: la selfie
 * del marcaje NO enrola. Sin este rostro, la persona no puede marcar. Diálogo
 * controlado: se abre desde la fila o desde el aviso de "pendiente enrolar rostro".
 */
function EnrollFaceDialog({
  employee,
  onClose,
  onDone,
}: {
  employee: { id: string; name: string } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const updateFn = useServerFn(updateEmployee);
  const [saving, setSaving] = useState(false);

  const save = async (descriptor: number[] | null) => {
    if (!employee) return;
    if (!descriptor) {
      toast.error("No se detectó el rostro. Acércate a la cámara con buena luz e inténtalo de nuevo.");
      return;
    }
    setSaving(true);
    try {
      await updateFn({ data: { id: employee.id, face_descriptor: descriptor } });
      toast.success(`Rostro de ${employee.name} registrado. Ya puede marcar.`);
      onClose();
      onDone();
    } catch (e) {
      toast.error(errorMsg(e, "No se pudo guardar el rostro"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!employee} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Enrolar rostro · {employee?.name}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          Foto de referencia con la que el marcaje verificará su identidad. Es de una sola vez.
          Buena luz, rostro de frente y sin lentes oscuros. {saving && "Guardando…"}
        </p>
        {employee && (
          <SelfieCapture
            requireDescriptor
            confirmLabel="Guardar rostro"
            onCapture={(_url, desc) => save(desc)}
            onCancel={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Hora de entrada del equipo por tienda (agentes). El GT la pone UNA VEZ, precargada
 * con la hora que su gente ya marca de verdad (no la teclea a ciegas). Después queda
 * bloqueada para el GT; el GZ/Operaciones puede cambiarla. Solo afecta a los agentes;
 * GT y GZ tienen su propia regla (8:00).
 */
function StoreEntryHoursCard({ storeId, zoneId }: { storeId: string; zoneId: string }) {
  const getFn = useServerFn(getStoreEntryHours);
  const setFn = useServerFn(setStoreEntryHour);
  const qc = useQueryClient();
  const args: { storeId?: string; zoneId?: string } = {};
  if (storeId !== "all") args.storeId = storeId;
  else if (zoneId !== "all") args.zoneId = zoneId;
  const { data } = useQuery({
    queryKey: ["storeEntryHours", zoneId, storeId],
    queryFn: () => getFn({ data: args }),
    refetchInterval: false,
  });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  if (!data) return null;
  const rows = data.rows ?? [];
  if (!rows.length) return null;
  const pendientes = rows.filter((r) => !r.configured).length;

  const save = async (r: (typeof rows)[number]) => {
    const hhmm = draft[r.storeId] ?? r.configured ?? r.suggested ?? "06:00";
    const [h, m] = hhmm.split(":").map(Number);
    const amEntryMin = h * 60 + (m || 0);
    if (!(amEntryMin >= 240 && amEntryMin <= 720)) {
      toast.error("La hora de entrada debe estar entre 04:00 y 12:00.");
      return;
    }
    setSavingId(r.storeId);
    try {
      await setFn({ data: { storeId: r.storeId, amEntryMin } });
      toast.success(`Hora de entrada de ${r.code} guardada: ${hhmm}. Aplica desde hoy; los días anteriores no cambian.`);
      qc.invalidateQueries({ queryKey: ["storeEntryHours"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    } catch (e) {
      toast.error(errorMsg(e, "No se pudo guardar la hora"));
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="bg-card rounded-2xl border border-border overflow-hidden">
      <div className="p-4 border-b border-border flex items-center gap-2 flex-wrap">
        <Clock className="h-4 w-4 text-accent" />
        <h3 className="font-semibold text-foreground">Hora de entrada del equipo</h3>
        {pendientes > 0 && (
          <Badge className="bg-destructive text-destructive-foreground hover:bg-destructive">{pendientes} sin configurar</Badge>
        )}
        <p className="w-full text-xs text-muted-foreground">
          A qué hora entra el turno de la mañana en tu tienda. Solo aplica a los agentes (Productos/MBK); el turno de la noche se corre solo.
          {data.canEditFree ? "" : " Se configura una vez; para cambiarla pídeselo a tu Gerente de Zona."}
        </p>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-secondary/50">
              <TableHead>Tienda</TableHead>
              <TableHead>Hora actual</TableHead>
              <TableHead>Tu equipo entra ~</TableHead>
              <TableHead className="text-right">Configurar</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const locked = !data.canEditFree && !!r.configured; // GT ya la fijó
              return (
                <TableRow key={r.storeId}>
                  <TableCell>
                    <div className="font-mono text-foreground">{r.code}</div>
                    <div className="text-xs text-muted-foreground">{r.name}</div>
                  </TableCell>
                  <TableCell>
                    {r.configured ? (
                      <span className="font-mono">{r.configured}</span>
                    ) : (
                      <Badge variant="outline" className="border-amber-500 text-amber-700">Sin configurar (6:00 por defecto)</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {r.suggested ? (
                      <>
                        <span className="font-mono">{r.suggested}</span>
                        <span className="text-xs text-muted-foreground"> · {r.samples} marcajes</span>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">sin datos aún</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {locked ? (
                      <span className="text-xs text-muted-foreground">bloqueada</span>
                    ) : (
                      <div className="flex items-center gap-1.5 justify-end">
                        <input
                          type="time"
                          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                          defaultValue={r.configured ?? r.suggested ?? "06:00"}
                          onChange={(e) => setDraft((d) => ({ ...d, [r.storeId]: e.target.value }))}
                        />
                        <Button size="sm" disabled={savingId === r.storeId} onClick={() => save(r)}
                          className="bg-accent text-accent-foreground hover:bg-accent/90">
                          {savingId === r.storeId ? "…" : r.configured ? "Cambiar" : "Guardar"}
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// =====================================================================
// ZONAS
// =====================================================================
function ZonesPanel() {
  const listFn = useServerFn(listZones);
  const createFn = useServerFn(createZone);
  const updateFn = useServerFn(updateZone);
  const deleteFn = useServerFn(deleteZone);
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["zones"], queryFn: () => listFn() });
  const zones = data ?? [];
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<(typeof zones)[number] | null>(null);
  const [form, setForm] = useState({ code: "", name: "", active: true });

  useEffect(() => {
    if (editing) setForm({ code: editing.code, name: editing.name, active: editing.active });
    else setForm({ code: "", name: "", active: true });
  }, [editing, open]);

  const save = async () => {
    try {
      if (editing) {
        await updateFn({ data: { id: editing.id, name: form.name, active: form.active } });
        toast.success("Zona actualizada");
      } else {
        await createFn({ data: { code: form.code, name: form.name, active: form.active } });
        toast.success("Zona creada");
      }
      setOpen(false); setEditing(null);
      qc.invalidateQueries({ queryKey: ["zones"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error al guardar");
    }
  };

  const remove = async (id: string) => {
    if (!confirm("¿Eliminar esta zona? Las tiendas quedarán sin zona asignada.")) return;
    try {
      await deleteFn({ data: { id } });
      toast.success("Zona eliminada");
      qc.invalidateQueries({ queryKey: ["zones"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error al eliminar");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-foreground">Zonas</h2>
          <p className="text-sm text-muted-foreground">{zones.length} registradas</p>
        </div>
        <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setEditing(null); }}>
          <DialogTrigger asChild>
            <Button className="bg-accent text-accent-foreground hover:bg-accent/90">
              <Plus className="h-4 w-4 mr-2" /> Nueva zona
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>{editing ? "Editar zona" : "Nueva zona"}</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>Código</Label>
                <Input disabled={!!editing} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="Ej. NORTE, SUR, METRO" />
              </div>
              <div>
                <Label>Nombre</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ej. Zona Norte" />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
                Activa
              </label>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
              <Button onClick={save} className="bg-accent text-accent-foreground hover:bg-accent/90">Guardar</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      <div className="bg-card rounded-2xl border border-border overflow-hidden">
        <Table>
          <TableHeader><TableRow className="bg-secondary/50">
            <TableHead>Código</TableHead><TableHead>Nombre</TableHead><TableHead>Estado</TableHead><TableHead className="text-right">Acciones</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Cargando…</TableCell></TableRow>
            ) : zones.length === 0 ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Crea la primera zona para agrupar tus tiendas.</TableCell></TableRow>
            ) : zones.map((z) => (
              <TableRow key={z.id}>
                <TableCell className="font-mono text-foreground">{z.code}</TableCell>
                <TableCell className="font-medium text-foreground">{z.name}</TableCell>
                <TableCell>{z.active ? <Badge className="bg-[oklch(0.65_0.16_155)] text-white">Activa</Badge> : <Badge variant="secondary">Inactiva</Badge>}</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => { setEditing(z); setOpen(true); }}><Pencil className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="sm" onClick={() => remove(z.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// =====================================================================
// USUARIOS ADMIN
// =====================================================================
function AdminUsersPanel({ isAdmin }: { isAdmin: boolean }) {
  const listFn = useServerFn(listAdminUsers);
  const upsertFn = useServerFn(upsertAdminUser);
  const removeFn = useServerFn(removeAdminRole);
  const setZonesFn = useServerFn(setUserZones);
  const setStoresFn = useServerFn(setUserStores);
  const seedFn = useServerFn(seedZoneManagers);
  const seedGoFn = useServerFn(seedOperationsManager);
  const seedGtFn = useServerFn(seedStoreManagers);
  const seedExtraFn = useServerFn(seedExtraSuperAdmins);
  const zonesFn = useServerFn(listZones);
  const storesFn = useServerFn(listStores);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({ queryKey: ["adminUsers"], queryFn: () => listFn() });
  const { data: zones } = useQuery({ queryKey: ["zones"], queryFn: () => zonesFn() });
  const { data: stores } = useQuery({ queryKey: ["stores"], queryFn: () => storesFn() });
  const users = data ?? [];

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    email: "", password: "", role: "gerente_tienda" as "admin" | "gerente_operaciones" | "gerente_tienda" | "gerente_zona",
    zone_ids: [] as string[], store_ids: [] as string[],
  });
  const [editing, setEditing] = useState<(typeof users)[number] | null>(null);
  const [editZones, setEditZones] = useState<Set<string>>(new Set());
  const [editStores, setEditStores] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (editing) {
      setEditZones(new Set(editing.zones.map((z) => z.id)));
      setEditStores(new Set(editing.stores.map((s) => s.id)));
    }
  }, [editing]);

  const save = async () => {
    try {
      const r = await upsertFn({ data: {
        email: form.email,
        password: form.password || undefined,
        role: form.role,
        zone_ids: form.role === "gerente_zona" ? form.zone_ids : undefined,
        store_ids: form.role === "gerente_tienda" ? form.store_ids : undefined,
      }});
      if (!r.ok) { toast.error(r.error); return; }
      toast.success("Usuario admin creado/actualizado");
      setOpen(false);
      setForm({ email: "", password: "", role: "gerente_tienda", zone_ids: [], store_ids: [] });
      qc.invalidateQueries({ queryKey: ["adminUsers"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      if (editing.roles.includes("gerente_zona"))
        await setZonesFn({ data: { user_id: editing.user_id, zone_ids: Array.from(editZones) } });
      if (editing.roles.includes("gerente_tienda"))
        await setStoresFn({ data: { user_id: editing.user_id, store_ids: Array.from(editStores) } });
      toast.success("Asignaciones actualizadas");
      setEditing(null);
      qc.invalidateQueries({ queryKey: ["adminUsers"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  };

  const removeRole = async (user_id: string, role: string) => {
    if (!confirm(`¿Quitar rol "${ADMIN_ROLE_LABELS[role] ?? role}" a este usuario?`)) return;
    try {
      await removeFn({ data: { user_id, role: role as "admin" | "gerente_operaciones" | "gerente_tienda" | "gerente_zona" } });
      toast.success("Rol removido");
      qc.invalidateQueries({ queryKey: ["adminUsers"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Error");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-foreground">Usuarios administrativos</h2>
          <p className="text-sm text-muted-foreground">Gestiona quién puede acceder al panel y qué tiendas/zonas ve</p>
        </div>
        <div className="flex gap-2">
          <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="bg-accent text-accent-foreground hover:bg-accent/90">
              <Plus className="h-4 w-4 mr-2" /> Nuevo usuario admin
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Nuevo usuario administrativo</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>Email</Label>
                <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="usuario@empresa.com" />
              </div>
              <div>
                <Label>Contraseña inicial (sólo si el usuario no existe)</Label>
                <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="mínimo 8 caracteres" />
              </div>
              <div>
                <Label>Rol</Label>
                <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v as typeof form.role })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="gerente_tienda">Gerente de Tienda</SelectItem>
                    <SelectItem value="gerente_zona">Gerente de Zona (Admin)</SelectItem>
                    {isAdmin && <SelectItem value="gerente_operaciones">Gerente de Operaciones</SelectItem>}
                    {isAdmin && <SelectItem value="admin">Administrador</SelectItem>}
                  </SelectContent>
                </Select>
              </div>
              {form.role === "gerente_tienda" && (
                <div className="rounded-xl border border-border p-2 bg-secondary/40 max-h-48 overflow-y-auto space-y-1">
                  <p className="text-xs text-muted-foreground px-1">Tiendas asignadas</p>
                  {(stores ?? []).map((s) => (
                    <label key={s.id} className="flex items-center gap-2 text-sm py-1 px-1">
                      <input type="checkbox" checked={form.store_ids.includes(s.id)} onChange={(e) => {
                        setForm({ ...form, store_ids: e.target.checked ? [...form.store_ids, s.id] : form.store_ids.filter((x) => x !== s.id) });
                      }} />
                      <span className="font-mono text-xs">{s.code}</span><span>{s.name}</span>
                    </label>
                  ))}
                </div>
              )}
              {form.role === "gerente_zona" && (
                <div className="rounded-xl border border-border p-2 bg-secondary/40 max-h-48 overflow-y-auto space-y-1">
                  <p className="text-xs text-muted-foreground px-1">Zonas asignadas</p>
                  {(zones ?? []).map((z) => (
                    <label key={z.id} className="flex items-center gap-2 text-sm py-1 px-1">
                      <input type="checkbox" checked={form.zone_ids.includes(z.id)} onChange={(e) => {
                        setForm({ ...form, zone_ids: e.target.checked ? [...form.zone_ids, z.id] : form.zone_ids.filter((x) => x !== z.id) });
                      }} />
                      <span className="font-mono text-xs">{z.code}</span><span>{z.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
              <Button onClick={save} className="bg-accent text-accent-foreground hover:bg-accent/90">Guardar</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      <div className="bg-card rounded-2xl border border-border overflow-hidden">
        <Table>
          <TableHeader><TableRow className="bg-secondary/50">
            <TableHead>Email</TableHead><TableHead>Roles</TableHead><TableHead>Alcance</TableHead><TableHead className="text-right">Acciones</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Cargando…</TableCell></TableRow>
            ) : users.length === 0 ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Sin usuarios administrativos.</TableCell></TableRow>
            ) : users.map((u) => (
              <TableRow key={u.user_id}>
                <TableCell className="font-medium text-foreground">{u.email ?? <span className="text-muted-foreground italic">sin email</span>}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {u.roles.map((r) => (
                      <Badge key={r} variant="secondary" className="text-xs">
                        {ADMIN_ROLE_LABELS[r] ?? r}
                        {(isAdmin || (r !== "admin" && r !== "gerente_operaciones")) && (
                          <button className="ml-1 hover:text-destructive" onClick={() => removeRole(u.user_id, r)}>×</button>
                        )}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {u.zones.length > 0 && <div>Zonas: {u.zones.map((z) => z.code).join(", ")}</div>}
                  {u.stores.length > 0 && <div>Tiendas: {u.stores.map((s) => s.code).join(", ")}</div>}
                  {u.roles.includes("admin") || u.roles.includes("gerente_operaciones") ? <div>Todas las tiendas</div> : null}
                </TableCell>
                <TableCell className="text-right">
                  {(u.roles.includes("gerente_zona") || u.roles.includes("gerente_tienda")) && (
                    <Button variant="ghost" size="sm" onClick={() => setEditing(u)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {editing && (
        <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Editar asignaciones · {editing.email}</DialogTitle></DialogHeader>
            <div className="space-y-3">
              {editing.roles.includes("gerente_zona") && (
                <div>
                  <Label className="text-sm">Zonas asignadas</Label>
                  <div className="rounded-xl border border-border p-2 bg-secondary/40 max-h-48 overflow-y-auto space-y-1 mt-1">
                    {(zones ?? []).map((z) => (
                      <label key={z.id} className="flex items-center gap-2 text-sm py-1 px-1">
                        <input type="checkbox" checked={editZones.has(z.id)} onChange={(e) => {
                          const n = new Set(editZones); if (e.target.checked) n.add(z.id); else n.delete(z.id); setEditZones(n);
                        }} />
                        <span className="font-mono text-xs">{z.code}</span><span>{z.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
              {editing.roles.includes("gerente_tienda") && (
                <div>
                  <Label className="text-sm">Tiendas asignadas</Label>
                  <div className="rounded-xl border border-border p-2 bg-secondary/40 max-h-48 overflow-y-auto space-y-1 mt-1">
                    {(stores ?? []).map((s) => (
                      <label key={s.id} className="flex items-center gap-2 text-sm py-1 px-1">
                        <input type="checkbox" checked={editStores.has(s.id)} onChange={(e) => {
                          const n = new Set(editStores); if (e.target.checked) n.add(s.id); else n.delete(s.id); setEditStores(n);
                        }} />
                        <span className="font-mono text-xs">{s.code}</span><span>{s.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditing(null)}>Cancelar</Button>
              <Button onClick={saveEdit} className="bg-accent text-accent-foreground hover:bg-accent/90">Guardar</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// =====================================================================
// MODAL MARCAJE SEMANAL POR PERSONA
// =====================================================================
function EmployeeWeeklyModal({
  employeeId,
  employeeName,
  onClose,
}: {
  employeeId: string;
  employeeName: string;
  onClose: () => void;
}) {
  const fetchFn = useServerFn(getEmployeeWeeklyMarks);
  const [range, setRange] = useState<"current_week" | "previous_week" | "current_month" | "payroll">("current_week");
  const today = new Date().toISOString().slice(0, 10);
  const fifteenAgo = new Date(); fifteenAgo.setDate(fifteenAgo.getDate() - 14);
  const [from, setFrom] = useState(fifteenAgo.toISOString().slice(0, 10));
  const [to, setTo] = useState(today);

  const { data, isLoading } = useQuery({
    queryKey: ["empWeekly", employeeId, range, range === "payroll" ? from : null, range === "payroll" ? to : null],
    queryFn: () => fetchFn({ data: { employeeId, range, ...(range === "payroll" ? { from, to } : {}) } }),
  });

  const dayName = (iso: string) => {
    const d = new Date(iso + "T00:00:00");
    return ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"][(d.getDay() + 6) % 7];
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><CalendarIcon className="h-5 w-5" /> {employeeName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[180px]">
              <Label className="text-xs">Rango</Label>
              <Select value={range} onValueChange={(v) => setRange(v as typeof range)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="current_week">Semana actual</SelectItem>
                  <SelectItem value="previous_week">Semana anterior</SelectItem>
                  <SelectItem value="current_month">Mes actual</SelectItem>
                  <SelectItem value="payroll">Semana planilla</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {range === "payroll" && (
              <>
                <div><Label className="text-xs">Desde</Label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
                <div><Label className="text-xs">Hasta</Label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
              </>
            )}
          </div>

          {isLoading || !data ? (
            <p className="text-center py-8 text-muted-foreground">Cargando…</p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-xl bg-primary text-primary-foreground p-3">
                  <div className="text-2xl font-bold">{data.total_hours}</div>
                  <div className="text-xs opacity-90">Horas totales</div>
                </div>
                <div className="rounded-xl bg-accent text-accent-foreground p-3">
                  <div className="text-2xl font-bold">{data.days_present}</div>
                  <div className="text-xs opacity-90">Días con marcaje</div>
                </div>
                <div className="rounded-xl bg-secondary p-3">
                  <div className="text-2xl font-bold">{data.total_marks}</div>
                  <div className="text-xs text-muted-foreground">Marcajes totales</div>
                </div>
              </div>

              <div className="bg-card rounded-2xl border border-border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-secondary/50">
                      <TableHead>Día</TableHead>
                      <TableHead>Entrada</TableHead>
                      <TableHead>Salida</TableHead>
                      <TableHead className="text-right">Marcajes</TableHead>
                      <TableHead className="text-right">Horas</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.days.map((d) => (
                      <TableRow key={d.date} className={d.marks.length === 0 ? "opacity-50" : ""}>
                        <TableCell>
                          <div className="font-medium text-foreground">{dayName(d.date)}</div>
                          <div className="text-xs text-muted-foreground">{d.date}</div>
                        </TableCell>
                        <TableCell className="text-sm">{d.first_entry ? new Date(d.first_entry).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" }) : "—"}</TableCell>
                        <TableCell className="text-sm">{d.last_exit ? new Date(d.last_exit).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" }) : "—"}</TableCell>
                        <TableCell className="text-right">
                          <span className="text-primary">{d.entries}</span> / <span className="text-accent">{d.exits}</span>
                        </TableCell>
                        <TableCell className="text-right font-medium">{d.hours > 0 ? d.hours : "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
