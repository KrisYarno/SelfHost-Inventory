"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, HardDrive, RefreshCw } from "lucide-react";
import { useBackups, useCreateBackup } from "@/hooks/use-admin";

export default function AdminBackupPage() {
  const { data: files = [], refetch } = useBackups();
  const createBackupMutation = useCreateBackup();
  const loading = createBackupMutation.isPending;

  const createBackup = async () => {
    try {
      await createBackupMutation.mutateAsync();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Backup failed");
    }
  };

  const download = async (name: string) => {
    const res = await fetch(`/api/admin/backup?file=${encodeURIComponent(name)}`);
    if (!res.ok) return;
    const blob = await res.blob();
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Database Backups</h1>
          <p className="text-muted-foreground">
            Create a manual backup and download or retrieve the latest backups from the backup
            volume.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
          <Button onClick={createBackup} disabled={loading}>
            <HardDrive className="h-4 w-4 mr-2" />
            {loading ? "Creating…" : "Create Backup"}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Available Backups</CardTitle>
          <CardDescription>From the mounted backup volume (/backup)</CardDescription>
        </CardHeader>
        <CardContent>
          {files.length === 0 ? (
            <p className="text-muted-foreground">No backup files found yet.</p>
          ) : (
            <ul className="divide-y">
              {files.map((f) => (
                <li key={f.name} className="flex items-center justify-between py-2">
                  <div className="truncate pr-2">
                    <p className="font-medium truncate">{f.name}</p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => download(f.name)}>
                    <Download className="h-4 w-4 mr-2" /> Download
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
