import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IsOptional, IsString, Matches } from 'class-validator';
import { OrdersService } from './orders.service';

class CreateOrderDto {
  @IsString()
  sku!: string;

  @IsOptional()
  @IsString()
  @Matches(/^ord_[A-Za-z0-9_-]+$/)
  id?: string;//todo надо dto сделать
}

@Controller('api/orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  create(@Body() body: CreateOrderDto) {
    return this.orders.create(body.sku, body.id);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.orders.get(id);
  }
}
