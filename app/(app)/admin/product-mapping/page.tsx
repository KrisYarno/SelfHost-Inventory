'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Search, Filter, MapPin, AlertCircle, Undo2, Check, X } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useToast } from '@/hooks/use-toast'
import { useDebounce } from '@/hooks/use-debounce'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import { 
  DropdownMenu, 
  DropdownMenuContent, 
  DropdownMenuItem, 
  DropdownMenuTrigger 
} from '@/components/ui/dropdown-menu'

interface WooCommerceProduct {
  id: string
  name: string
  sku: string
  mappedProductId?: string
  mappedProductName?: string
}

interface InternalProduct {
  id: number
  name: string
  sku: string
}

interface MappingSuggestion {
  wooProductId: string
  suggestedProductId: string
  confidence: number
}

export default function ProductMappingPage() {
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedTab, setSelectedTab] = useState<'unmapped' | 'all'>('unmapped')
  const [selectedProducts, setSelectedProducts] = useState<Set<string>>(new Set())
  const [showOnlyConflicts, setShowOnlyConflicts] = useState(false)
  const [recentMappings, setRecentMappings] = useState<Array<{
    id: string
    wooProductId: string
    wooProductName: string
    internalProductId: string
    internalProductName: string
    timestamp: Date
  }>>([])

  const queryClient = useQueryClient()
  const { toast } = useToast()
  const debouncedSearch = useDebounce(searchQuery, 300)

  // Fetch unmapped products
  const { data: unmappedProducts, isLoading: loadingUnmapped } = useQuery({
    queryKey: ['unmapped-products', debouncedSearch, selectedTab, showOnlyConflicts],
    queryFn: async () => {
      const params = new URLSearchParams({
        search: debouncedSearch,
        tab: selectedTab,
        conflicts: showOnlyConflicts.toString()
      })
      const res = await fetch(`/api/products/unmapped?${params}`)
      if (!res.ok) throw new Error('Failed to fetch products')
      return res.json() as Promise<WooCommerceProduct[]>
    }
  })

  // Fetch internal products for dropdown
  const { data: internalProducts } = useQuery({
    queryKey: ['internal-products'],
    queryFn: async () => {
      const res = await fetch('/api/products')
      if (!res.ok) throw new Error('Failed to fetch internal products')
      return res.json() as Promise<InternalProduct[]>
    }
  })

  // Fetch mapping suggestions
  const { data: suggestions } = useQuery({
    queryKey: ['mapping-suggestions', selectedProducts],
    queryFn: async () => {
      if (selectedProducts.size === 0) return []
      const res = await fetch('/api/products/mapping-suggestions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: Array.from(selectedProducts) })
      })
      if (!res.ok) throw new Error('Failed to fetch suggestions')
      return res.json() as Promise<MappingSuggestion[]>
    },
    enabled: selectedProducts.size > 0
  })

  // Create mapping mutation
  const createMapping = useMutation({
    mutationFn: async (data: { wooProductId: string; internalProductId: string }) => {
      const res = await fetch('/api/products/map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })
      if (!res.ok) throw new Error('Failed to create mapping')
      return res.json()
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['unmapped-products'] })
      const wooProduct = unmappedProducts?.find(p => p.id === variables.wooProductId)
      const internalProduct = internalProducts?.find(p => p.id === variables.internalProductId)
      
      if (wooProduct && internalProduct) {
        setRecentMappings(prev => [{
          id: data.id,
          wooProductId: variables.wooProductId,
          wooProductName: wooProduct.name,
          internalProductId: variables.internalProductId,
          internalProductName: internalProduct.name,
          timestamp: new Date()
        }, ...prev].slice(0, 5))
      }
      
      setSelectedProducts(prev => {
        const next = new Set(prev)
        next.delete(variables.wooProductId)
        return next
      })
      
      toast({
        title: 'Product mapped successfully',
        description: `${wooProduct?.name} → ${internalProduct?.name}`
      })
    },
    onError: () => {
      toast({
        title: 'Failed to map product',
        description: 'Please try again',
        variant: 'destructive'
      })
    }
  })

  // Delete mapping mutation
  const deleteMapping = useMutation({
    mutationFn: async (mappingId: string) => {
      const res = await fetch(`/api/products/map/${mappingId}`, {
        method: 'DELETE'
      })
      if (!res.ok) throw new Error('Failed to delete mapping')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['unmapped-products'] })
      toast({
        title: 'Mapping removed',
        description: 'The product mapping has been undone'
      })
    }
  })

  // Bulk map selected products
  const handleBulkMap = async () => {
    if (!suggestions || selectedProducts.size === 0) return

    const mappingsToCreate = Array.from(selectedProducts).map(wooProductId => {
      const suggestion = suggestions.find(s => s.wooProductId === wooProductId)
      const selectedValue = (document.getElementById(`select-${wooProductId}`) as HTMLSelectElement)?.value
      
      return {
        wooProductId,
        internalProductId: selectedValue || suggestion?.suggestedProductId || ''
      }
    }).filter(m => m.internalProductId)

    for (const mapping of mappingsToCreate) {
      await createMapping.mutateAsync(mapping)
    }
  }

  const stats = {
    mapped: unmappedProducts?.filter(p => p.mappedProductId).length || 0,
    unmapped: unmappedProducts?.filter(p => !p.mappedProductId).length || 0,
    total: unmappedProducts?.length || 0
  }

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold">Product Mapping</h1>
          <p className="text-muted-foreground mt-1">
            Map WooCommerce products to internal inventory
          </p>
        </div>
        <div className="flex gap-2">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2">
                <Check className="h-4 w-4 text-green-600" />
                <span className="text-sm font-medium">{stats.mapped} Mapped</span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2">
                <X className="h-4 w-4 text-red-600" />
                <span className="text-sm font-medium">{stats.unmapped} Unmapped</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Recent Mappings */}
      {recentMappings.length > 0 && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            <div className="flex items-center justify-between">
              <span>Recent mappings can be undone</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm">
                    <Undo2 className="h-4 w-4 mr-2" />
                    Undo
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {recentMappings.map(mapping => (
                    <DropdownMenuItem
                      key={mapping.id}
                      onClick={() => deleteMapping.mutate(mapping.id)}
                    >
                      {mapping.wooProductName} → {mapping.internalProductName}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Controls */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex-1">
              <Input
                placeholder="Search products..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full"
                icon={<Search className="h-4 w-4" />}
              />
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowOnlyConflicts(!showOnlyConflicts)}
                className={showOnlyConflicts ? 'bg-accent' : ''}
              >
                <Filter className="h-4 w-4 mr-2" />
                Conflicts Only
              </Button>
              {selectedProducts.size > 0 && (
                <Button
                  onClick={handleBulkMap}
                  disabled={createMapping.isPending}
                >
                  <MapPin className="h-4 w-4 mr-2" />
                  Map Selected ({selectedProducts.size})
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs value={selectedTab} onValueChange={(v) => setSelectedTab(v as 'unmapped' | 'all')}>
        <TabsList className="grid w-full md:w-[400px] grid-cols-2">
          <TabsTrigger value="unmapped">Unmapped</TabsTrigger>
          <TabsTrigger value="all">All Products</TabsTrigger>
        </TabsList>

        <TabsContent value={selectedTab} className="mt-4">
          {loadingUnmapped ? (
            <Card>
              <CardContent className="p-6">
                <div className="space-y-4">
                  {[...Array(5)].map((_, i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Desktop View */}
              <Card className="hidden md:block">
                <ScrollArea className="h-[600px]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-12">
                          <Checkbox
                            checked={selectedProducts.size === unmappedProducts?.length}
                            onCheckedChange={(checked) => {
                              if (checked) {
                                setSelectedProducts(new Set(unmappedProducts?.map(p => p.id)))
                              } else {
                                setSelectedProducts(new Set())
                              }
                            }}
                          />
                        </TableHead>
                        <TableHead>WooCommerce Product</TableHead>
                        <TableHead>SKU</TableHead>
                        <TableHead>Internal Product</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {unmappedProducts?.map((product) => {
                        const suggestion = suggestions?.find(s => s.wooProductId === product.id)
                        return (
                          <TableRow key={product.id}>
                            <TableCell>
                              <Checkbox
                                checked={selectedProducts.has(product.id)}
                                onCheckedChange={(checked) => {
                                  const next = new Set(selectedProducts)
                                  if (checked) {
                                    next.add(product.id)
                                  } else {
                                    next.delete(product.id)
                                  }
                                  setSelectedProducts(next)
                                }}
                              />
                            </TableCell>
                            <TableCell className="font-medium">{product.name}</TableCell>
                            <TableCell>
                              <Badge variant="outline">{product.sku || 'No SKU'}</Badge>
                            </TableCell>
                            <TableCell>
                              {product.mappedProductId ? (
                                <div className="flex items-center gap-2">
                                  <span className="text-sm">{product.mappedProductName}</span>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                      // Find and delete the mapping
                                      // This would need the mapping ID from the API
                                    }}
                                  >
                                    <X className="h-3 w-3" />
                                  </Button>
                                </div>
                              ) : (
                                <Select
                                  id={`select-${product.id}`}
                                  defaultValue={suggestion?.suggestedProductId}
                                >
                                  <SelectTrigger className="w-[250px]">
                                    <SelectValue placeholder="Select product..." />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {suggestion && (
                                      <SelectItem 
                                        value={suggestion.suggestedProductId}
                                        className="font-medium"
                                      >
                                        ⭐ {internalProducts?.find(p => p.id.toString() === suggestion.suggestedProductId)?.name}
                                        <span className="text-xs text-muted-foreground ml-2">
                                          {Math.round(suggestion.confidence * 100)}% match
                                        </span>
                                      </SelectItem>
                                    )}
                                    {internalProducts?.map((internal) => (
                                      <SelectItem key={internal.id} value={internal.id.toString()}>
                                        {internal.name}
                                        {internal.sku && (
                                          <span className="text-xs text-muted-foreground ml-2">
                                            {internal.sku}
                                          </span>
                                        )}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              {!product.mappedProductId && (
                                <Button
                                  size="sm"
                                  onClick={() => {
                                    const selectedValue = (document.getElementById(`select-${product.id}`) as HTMLSelectElement)?.value
                                    if (selectedValue) {
                                      createMapping.mutate({
                                        wooProductId: product.id,
                                        internalProductId: selectedValue
                                      })
                                    }
                                  }}
                                  disabled={createMapping.isPending}
                                >
                                  Map
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </Card>

              {/* Mobile View */}
              <div className="md:hidden space-y-4">
                {unmappedProducts?.map((product) => {
                  const suggestion = suggestions?.find(s => s.wooProductId === product.id)
                  return (
                    <Card key={product.id}>
                      <CardHeader className="pb-3">
                        <div className="flex items-start justify-between">
                          <div className="flex items-start gap-3">
                            <Checkbox
                              checked={selectedProducts.has(product.id)}
                              onCheckedChange={(checked) => {
                                const next = new Set(selectedProducts)
                                if (checked) {
                                  next.add(product.id)
                                } else {
                                  next.delete(product.id)
                                }
                                setSelectedProducts(next)
                              }}
                              className="mt-1"
                            />
                            <div>
                              <CardTitle className="text-base">{product.name}</CardTitle>
                              <CardDescription>
                                {product.sku && <Badge variant="outline" className="mt-1">{product.sku}</Badge>}
                              </CardDescription>
                            </div>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent>
                        {product.mappedProductId ? (
                          <div className="flex items-center justify-between">
                            <span className="text-sm">
                              Mapped to: <span className="font-medium">{product.mappedProductName}</span>
                            </span>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                // Delete mapping
                              }}
                            >
                              Remove
                            </Button>
                          </div>
                        ) : (
                          <div className="space-y-3">
                            <Select
                              id={`select-mobile-${product.id}`}
                              defaultValue={suggestion?.suggestedProductId}
                            >
                              <SelectTrigger className="w-full">
                                <SelectValue placeholder="Select product..." />
                              </SelectTrigger>
                              <SelectContent>
                                {suggestion && (
                                  <SelectItem 
                                    value={suggestion.suggestedProductId}
                                    className="font-medium"
                                  >
                                    ⭐ {internalProducts?.find(p => p.id.toString() === suggestion.suggestedProductId)?.name}
                                    <span className="text-xs text-muted-foreground ml-2">
                                      {Math.round(suggestion.confidence * 100)}% match
                                    </span>
                                  </SelectItem>
                                )}
                                {internalProducts?.map((internal) => (
                                  <SelectItem key={internal.id} value={internal.id.toString()}>
                                    {internal.name}
                                    {internal.sku && (
                                      <span className="text-xs text-muted-foreground ml-2">
                                        {internal.sku}
                                      </span>
                                    )}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Button
                              className="w-full"
                              onClick={() => {
                                const selectedValue = (document.getElementById(`select-mobile-${product.id}`) as HTMLSelectElement)?.value
                                if (selectedValue) {
                                  createMapping.mutate({
                                    wooProductId: product.id,
                                    internalProductId: selectedValue
                                  })
                                }
                              }}
                              disabled={createMapping.isPending}
                            >
                              <MapPin className="h-4 w-4 mr-2" />
                              Map Product
                            </Button>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}