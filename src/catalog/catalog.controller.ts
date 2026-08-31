import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { CatalogService } from './catalog.service';

@Controller('api/catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  storefront(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('type') type?: string,
  ) {
    return this.catalog.storefront({
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
      type,
    });
  }

  @Get('explain')
  explain() {
    return this.catalog.explainStorefront();
  }

  @Get(':sku')
  async getOne(@Param('sku') sku: string) {
    const product = await this.catalog.getBySku(sku);
    if (!product) {
      throw new NotFoundException({ error: 'sku_not_found', sku });
    }
    return {
      sku: product.sku,
      name: product.name,
      type: product.type,
      price: product.price,
      currency: product.currency,
      image: product.image,
      available: product.stock?.available ?? 0,
    };
  }
}
