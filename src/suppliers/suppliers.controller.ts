import {
  Body,
  Controller,
  Get,
  HttpException,
  Param,
  Post,
} from '@nestjs/common';
import { IsIn, IsString } from 'class-validator';
import { SuppliersService } from './suppliers.service';
import { SupplierError, SupplierId, SupplierMode } from './types';

class IssueDto {
  @IsString()
  request_id!: string;

  @IsString()
  sku!: string;

  @IsString()
  order_id!: string;
}

class BehaviorDto {
  @IsIn([
    'normal',
    'always_timeout',
    'always_unavailable',
    'always_out_of_stock',
    'random',
    'duplicate_code',
    'wrong_code',
    'error_after_issue',
  ])
  mode!: SupplierMode;
}

@Controller()
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Post('internal/suppliers/:id/issue')
  async issue(@Param('id') id: string, @Body() body: IssueDto) {
    const supplier = this.parseId(id);
    try {
      return await this.suppliers.issue(supplier, body);
    } catch (err) {
      if (err instanceof SupplierError) {
        throw new HttpException({ status: 'error', reason: err.reason }, err.httpStatus);
      }
      throw err;
    }
  }

  @Post('internal/suppliers/:id/behavior')
  setBehavior(@Param('id') id: string, @Body() body: BehaviorDto) {
    const supplier = this.parseId(id);
    this.suppliers.setMode(supplier, body.mode);
    return { supplier, mode: body.mode };
  }

  @Get('internal/suppliers/:id/behavior')
  getBehavior(@Param('id') id: string) {
    const supplier = this.parseId(id);
    return { supplier, mode: this.suppliers.getMode(supplier) };
  }

  private parseId(id: string): SupplierId {
    const upper = id.toUpperCase();
    if (upper !== 'A' && upper !== 'B') {
      throw new HttpException({ status: 'error', reason: 'unknown_supplier' }, 404);
    }
    return upper;
  }
}
