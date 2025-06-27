"use client";

import { useState } from "react";
import { Upload, FileSpreadsheet, AlertCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface BatchOperationsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BatchOperationsDialog({
  open,
  onOpenChange,
}: BatchOperationsDialogProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [batchAction, setBatchAction] = useState<"add" | "set">("add");
  const [batchQuantity, setBatchQuantity] = useState("");

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file && file.type === "text/csv") {
      setSelectedFile(file);
    }
  };

  const handleImport = () => {
    // Placeholder for CSV import functionality
    console.log("Importing CSV:", selectedFile);
  };

  const handleBatchAdjust = () => {
    // Placeholder for batch adjustment functionality
    console.log("Batch adjust:", batchAction, batchQuantity);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Batch Operations</DialogTitle>
          <DialogDescription>
            Import inventory data from CSV or apply bulk adjustments
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="import" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="import">CSV Import</TabsTrigger>
            <TabsTrigger value="batch">Batch Adjustment</TabsTrigger>
          </TabsList>

          <TabsContent value="import" className="space-y-4">
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                Upload a CSV file with columns: SKU, Product Name, Quantity
              </AlertDescription>
            </Alert>

            <div className="space-y-2">
              <Label htmlFor="csv-file">Select CSV File</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="csv-file"
                  type="file"
                  accept=".csv"
                  onChange={handleFileChange}
                  className="flex-1"
                />
                <Button variant="outline" size="icon">
                  <Upload className="h-4 w-4" />
                </Button>
              </div>
              {selectedFile && (
                <p className="text-sm text-muted-foreground">
                  Selected: {selectedFile.name}
                </p>
              )}
            </div>

            <div className="rounded-lg border bg-muted/50 p-4">
              <h4 className="font-medium mb-2">CSV Format Example:</h4>
              <pre className="text-xs font-mono">
{`SKU,Product Name,Quantity
PROD001,Widget A,100
PROD002,Widget B,50
PROD003,Widget C,75`}
              </pre>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button 
                onClick={handleImport} 
                disabled={!selectedFile}
                className="gap-2"
              >
                <FileSpreadsheet className="h-4 w-4" />
                Import CSV
              </Button>
            </DialogFooter>
          </TabsContent>

          <TabsContent value="batch" className="space-y-4">
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                This feature is coming soon. You'll be able to select multiple products
                and apply the same adjustment to all of them.
              </AlertDescription>
            </Alert>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Adjustment Type</Label>
                <Select 
                  value={batchAction} 
                  onValueChange={(value: "add" | "set") => setBatchAction(value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="add">Add to current quantity</SelectItem>
                    <SelectItem value="set">Set to specific quantity</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="batch-quantity">Quantity</Label>
                <Input
                  id="batch-quantity"
                  type="number"
                  value={batchQuantity}
                  onChange={(e) => setBatchQuantity(e.target.value)}
                  placeholder={batchAction === "add" ? "Amount to add/subtract" : "New quantity"}
                />
              </div>

              <div className="rounded-lg border bg-muted/50 p-4">
                <p className="text-sm text-muted-foreground">
                  Select products from the journal list, then use this dialog to apply
                  the same adjustment to all selected products.
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button 
                onClick={handleBatchAdjust} 
                disabled={!batchQuantity}
              >
                Apply to Selected
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}